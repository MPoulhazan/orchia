import { execFile } from 'node:child_process';
import type { McpServerConfig } from './mcpSource.ts';

/**
 * How a connector gets its access, found by asking the server before adding it,
 * so that adding one ends with a connector that works:
 *
 * - `local`: a command that runs on this computer, nothing to sign in to.
 * - `open`: the server answers without signing in.
 * - `browser`: OAuth that Claude Code does by itself (`claude mcp login` opens the
 *   browser). It needs the server to let clients register themselves.
 * - `token`: the server wants an access token in a header. GitHub's, for one: its
 *   OAuth has no client registration, so Claude Code can't sign in.
 * - `unreachable`: no MCP server answers at that address.
 */
export type ConnectorAuth =
  | { kind: 'local' }
  | { kind: 'open' }
  | { kind: 'browser' }
  | { kind: 'token'; help: TokenHelp }
  | { kind: 'unreachable'; error: string };

export interface TokenHelp {
  /** The service's name, for "Create a token on GitHub". */
  service: string | null;
  /** The page that creates a token. */
  createUrl: string | null;
  /** A CLI on this computer that is signed in to the service and can lend its token. */
  cli: string | null;
}

/** Services known to want a token, and where people get one. */
const TOKEN_SERVICES: { host: string; service: string; createUrl: string; cli?: { label: string; file: string; args: string[] } }[] = [
  {
    host: 'api.githubcopilot.com',
    service: 'GitHub',
    createUrl: 'https://github.com/settings/personal-access-tokens/new',
    cli: { label: 'GitHub CLI', file: 'gh', args: ['auth', 'token', '--hostname', 'github.com'] },
  },
];

const TIMEOUT_MS = 8000;

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
};

const knownService = (url: string) => TOKEN_SERVICES.find((s) => s.host === hostOf(url));

/** The token the service's CLI holds, or null when it is missing or signed out. */
export function cliToken(url: string): Promise<string | null> {
  const cli = knownService(url)?.cli;
  if (!cli) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(cli.file, cli.args, { timeout: 10_000, windowsHide: true }, (err, stdout) => {
      const token = String(stdout ?? '').trim();
      resolve(!err && /^[\w.-]{20,}$/.test(token) ? token : null);
    });
  });
}

export async function tokenHelp(url: string): Promise<TokenHelp> {
  const known = knownService(url);
  const cli = known?.cli && (await cliToken(url)) ? known.cli.label : null;
  return { service: known?.service ?? null, createUrl: known?.createUrl ?? null, cli };
}

const get = (url: string, init: RequestInit = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

async function json(url: string): Promise<any> {
  try {
    const res = await get(url, { headers: { accept: 'application/json' } });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** The MCP handshake's first message: any MCP server answers it, or says it wants a sign-in. */
function knock(server: Extract<McpServerConfig, { url: string }>): Promise<Response> {
  const headers = { accept: 'application/json, text/event-stream', ...server.headers };
  if (server.type === 'sse') return get(server.url, { headers });
  return get(server.url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agenthub', version: '1' } },
    }),
  });
}

/** The authorization server's metadata (RFC 8414 / OpenID), at the places clients look for it. */
async function authServerMetadata(issuer: string): Promise<any> {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/$/, '');
  const candidates = [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    ...(path ? [`${url.origin}${path}/.well-known/openid-configuration`] : []),
  ];
  for (const candidate of candidates) {
    const meta = await json(candidate);
    if (meta?.issuer || meta?.authorization_endpoint) return meta;
  }
  return null;
}

/** Whether Claude Code can sign in by itself: the server's OAuth lets clients register. */
async function canRegister(res: Response, serverUrl: string): Promise<boolean> {
  const url = new URL(serverUrl);
  const fromHeader = res.headers.get('www-authenticate')?.match(/resource_metadata="([^"]+)"/)?.[1];
  const path = url.pathname.replace(/\/$/, '');
  const resource =
    (fromHeader && (await json(fromHeader))) ??
    (await json(`${url.origin}/.well-known/oauth-protected-resource${path}`)) ??
    (await json(`${url.origin}/.well-known/oauth-protected-resource`));
  const meta = await authServerMetadata(resource?.authorization_servers?.[0] ?? url.origin);
  // Nothing published: Claude Code falls back to the default endpoints, which may work.
  if (!meta) return true;
  return !!meta.registration_endpoint || meta.client_id_metadata_document_supported === true;
}

export async function probeConnector(server: McpServerConfig): Promise<ConnectorAuth> {
  if (server.type === 'stdio') return { kind: 'local' };
  if (knownService(server.url) && !server.headers?.Authorization) return { kind: 'token', help: await tokenHelp(server.url) };
  let res: Response;
  try {
    res = await knock(server);
  } catch (err) {
    const timeout = (err as Error).name === 'TimeoutError';
    return { kind: 'unreachable', error: timeout ? 'The server did not answer.' : `Can't reach ${hostOf(server.url) || 'the server'}.` };
  }
  // Only the status matters: don't keep a stream open.
  res.body?.cancel().catch(() => {});
  if (res.status === 401 || res.status === 403) {
    if (server.headers?.Authorization) return { kind: 'unreachable', error: 'The service refused this token.' };
    return (await canRegister(res, server.url)) ? { kind: 'browser' } : { kind: 'token', help: await tokenHelp(server.url) };
  }
  if (res.status >= 500) return { kind: 'unreachable', error: `The server failed (${res.status}). Try again later.` };
  // An MCP server answers in JSON or as an event stream, even to refuse; a web page doesn't.
  if (!/json|event-stream/i.test(res.headers.get('content-type') ?? '')) return { kind: 'unreachable', error: 'No MCP server answers at this address.' };
  return { kind: 'open' };
}

/** Checks a token with the server before it is saved. */
export async function checkToken(url: string, type: 'http' | 'sse', token: string): Promise<void> {
  const auth = await probeConnector({ type, url, headers: { Authorization: `Bearer ${token}` } });
  if (auth.kind === 'unreachable') throw new Error(auth.error);
}

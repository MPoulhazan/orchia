/**
 * Reads an MCP server out of what people paste: a server URL, the command that
 * starts it (`npx -y @playwright/mcp@latest`), the `claude mcp add …` line a
 * README shows, or its JSON (`{"mcpServers": {"name": {…}}}`).
 *
 * No Node imports: the web app uses it too, to offer the server while typing.
 */

export type McpServerConfig =
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'stdio'; command: string; args: string[]; env?: Record<string, string> };

export interface McpSource {
  /** A name for it, which the user can change. */
  name: string;
  server: McpServerConfig;
}

/** What starts a local server; anything else is not taken for a command. */
const LAUNCHERS = /^(npx|bunx|pnpm|uvx|uv|pipx|node|deno|python3?|docker)(\.exe|\.cmd)?$/i;
export const NAME = /^[\w.-]{1,64}$/;

const words = (text: string) => text.match(/"[^"]*"|'[^']*'|\S+/g)?.map((w) => w.replace(/^(['"])([\s\S]*)\1$/, '$2')) ?? [];

/** `mcp.sentry.dev/mcp` → `sentry`; `@playwright/mcp@latest` → `playwright`; `@upstash/context7-mcp` → `context7`. */
export function nameFor(server: McpServerConfig): string {
  let name = '';
  if (server.type !== 'stdio') {
    try {
      const host = new URL(server.url).hostname.split('.');
      const parts = host.filter((p) => !/^(mcp|api|www|app)$/i.test(p));
      name = parts.length > 1 ? parts.at(-2)! : (parts[0] ?? host[0]);
    } catch {
      // Not a URL: no name.
    }
  } else {
    // The package or script: the first word that is not a flag. Without its version.
    const pkg = (server.args.find((a) => !a.startsWith('-') && !LAUNCHERS.test(a)) ?? server.command).replace(/(.)@[^/]*$/, '$1');
    const parts = pkg.split(/[\\/]/);
    const scope = parts.length > 1 ? parts.at(-2)!.replace(/^@/, '') : '';
    const base = parts.at(-1)!.replace(/\.(js|mjs|py)$/i, '');
    const cleaned = base.replace(/^(mcp-server-|server-|mcp-)/i, '').replace(/(-mcp-server|-mcp|-server)$/i, '');
    name = !cleaned || /^mcp$/i.test(cleaned) ? scope : cleaned;
  }
  return name.toLowerCase().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'server';
}

function fromJson(text: string): McpSource | null {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  let name = '';
  if (data.mcpServers && typeof data.mcpServers === 'object') {
    const entries = Object.entries(data.mcpServers);
    if (entries.length !== 1) return null;
    [name, data] = entries[0] as [string, any];
  }
  const server = configFrom(data);
  return server ? { name: NAME.test(name) ? name : nameFor(server), server } : null;
}

/** A server config from JSON: Claude Code's own shape, or what the web app sends. */
export function configFrom(data: any): McpServerConfig | null {
  if (typeof data?.url === 'string' && /^https?:\/\//.test(data.url)) {
    const headers = strings(data.headers);
    return { type: data.type === 'sse' ? 'sse' : 'http', url: data.url, ...(headers ? { headers } : {}) };
  }
  if (typeof data?.command === 'string' && data.command) {
    const env = strings(data.env);
    return { type: 'stdio', command: data.command, args: Array.isArray(data.args) ? data.args.map(String) : [], ...(env ? { env } : {}) };
  }
  return null;
}

function strings(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const out = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, String(v)]));
  return Object.keys(out).length ? out : undefined;
}

/** `claude mcp add [options] <name> <url or command> [args…]`. */
function fromClaudeCommand(rest: string[]): McpSource | null {
  let transport = '';
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    if (w === '--') {
      positional.push(...rest.slice(i + 1));
      break;
    }
    // Claude Code's own options, before or after the name; other flags belong to the command.
    if (/^(-[teHs]|--(transport|env|header|scope|client-id|callback-port))$/.test(w)) {
      const value = rest[++i] ?? '';
      if (w === '-t' || w === '--transport') transport = value;
      else if (w === '-e' || w === '--env') {
        const [k, ...v] = value.split('=');
        if (k) env[k] = v.join('=');
      } else if (w === '-H' || w === '--header') {
        const [k, ...v] = value.split(':');
        if (k && v.length) headers[k.trim()] = v.join(':').trim();
      }
      // --scope and the OAuth options: the scope is picked in Orchia, the rest is not supported.
      continue;
    }
    positional.push(w);
  }
  const [name, target, ...args] = positional;
  if (!name || !target || !NAME.test(name)) return null;
  if (/^https?:\/\//.test(target)) {
    return { name, server: { type: transport === 'sse' ? 'sse' : 'http', url: target, ...(Object.keys(headers).length ? { headers } : {}) } };
  }
  return { name, server: { type: 'stdio', command: target, args, ...(Object.keys(env).length ? { env } : {}) } };
}

export function parseMcpSource(text: string): McpSource | null {
  const input = text.trim();
  if (!input) return null;
  if (input.startsWith('{')) return fromJson(input);
  if (/^https?:\/\/\S+$/.test(input)) {
    const server: McpServerConfig = { type: /\/sse\/?$/.test(input) ? 'sse' : 'http', url: input };
    return { name: nameFor(server), server };
  }
  const all = words(input);
  if (/^claude(\.exe)?$/i.test(all[0] ?? '') && all[1] === 'mcp' && all[2] === 'add') return fromClaudeCommand(all.slice(3));
  if (!LAUNCHERS.test(all[0] ?? '') || all.length < 2) return null;
  const server: McpServerConfig = { type: 'stdio', command: all[0], args: all.slice(1) };
  return { name: nameFor(server), server };
}

/** One line for the server: its URL, or its command. */
export const describeServer = (server: McpServerConfig) => (server.type === 'stdio' ? [server.command, ...server.args].join(' ') : server.url);

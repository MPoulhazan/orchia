import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configFrom, describeServer, NAME, type McpServerConfig } from './mcpSource.ts';
import { samePath } from './projects.ts';
import { cleanEnv } from './session.ts';
import { readJsonFile, writeJsonFile } from './skills.ts';

const pty: typeof import('@lydell/node-pty') = createRequire(import.meta.url)('@lydell/node-pty');

/**
 * MCP servers ("connectors") a session can use, and turning them off per project.
 *
 * Claude Code reads them from the user's `~/.claude.json` (every project), the
 * project's entry in it (local scope, private to this machine), the project's
 * `.mcp.json` (shared through the repo), plugins, and the claude.ai account's
 * connectors. `claude mcp list`, run in the project, sees
 * them all and checks each one's health, so it is what we show; the files only
 * tell where each one comes from.
 *
 * Turning one off is per project: `disabledMcpServers` in the project's entry of
 * `~/.claude.json`, or `disabledMcpjsonServers` in `.claude/settings.local.json`
 * for `.mcp.json` servers, as Claude Code's own `/mcp disable` does.
 */

export type ConnectorSource = 'account' | 'user' | 'local' | 'project' | 'plugin';
/** `needs-token`: the server wants an access token, Claude Code can't sign in to it (no OAuth client registration). */
export type ConnectorState = 'connected' | 'needs-auth' | 'needs-token' | 'failed' | 'disabled' | 'pending' | 'unknown';

export interface Connector {
  /** The server's name in Claude Code, e.g. `github` or `claude.ai Gmail`. */
  name: string;
  /** What to show: without the `claude.ai ` or `plugin:x:` prefix. */
  label: string;
  source: ConnectorSource;
  /** URL or command. */
  target: string;
  state: ConnectorState;
  /** Claude Code's own words for the state, for a tooltip. */
  detail: string;
  /** Tool names of this server start with it: `mcp__<prefix>__<tool>`. */
  toolPrefix: string;
  /** Another connector, connected, that reaches the same server: this one needs nothing from the user. */
  duplicateOf?: string;
}

const CLAUDE_JSON = process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json');
const localSettingsFile = (cwd: string) => join(cwd, '.claude', 'settings.local.json');

/** The project's entries in `~/.claude.json`: keyed by path with forward slashes, sometimes once per drive-letter case. */
function projectEntries(config: any, cwd: string): [string, any][] {
  return Object.entries(config?.projects ?? {}).filter(([path]) => samePath(path, cwd)) as [string, any][];
}

/** The project's entries, to change: a new one, keyed the way Claude Code does, when there is none yet. */
function ownEntries(config: any, cwd: string): any[] {
  config.projects ??= {};
  const entries = projectEntries(config, cwd).map(([, entry]) => entry);
  if (entries.length) return entries;
  const entry = {};
  config.projects[cwd.replace(/\\/g, '/')] = entry;
  return [entry];
}

/** The part of a tool name Claude Code builds from the server name. */
export const toolPrefix = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, '_');

// ---- Reading -----------------------------------------------------------------------

/** Runs `claude mcp list` in the project. Takes several seconds: it connects to every server. */
function claudeMcpList(cwd: string): Promise<string> {
  const command = process.env.ORCHIA_CLAUDE_CLI ?? 'claude';
  return new Promise((resolve, reject) => {
    execFile(
      command,
      ['mcp', 'list'],
      { cwd, env: cleanEnv(), shell: process.platform === 'win32', timeout: 90_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => (err && !stdout ? reject(err) : resolve(stdout)),
    );
  });
}

/** `name: target - ✔ Connected`, one line per server. */
export function parseMcpList(text: string): { name: string; target: string; status: string }[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^(.+?): (.+) - (.+)$/);
    return match ? [{ name: match[1].trim(), target: match[2].trim(), status: match[3].trim() }] : [];
  });
}

function stateOf(status: string): ConnectorState {
  const s = status.toLowerCase();
  if (s.includes('disabled')) return 'disabled';
  if (s.includes('pending')) return 'pending';
  if (s.includes('dynamic client registration')) return 'needs-token';
  if (s.includes('auth')) return 'needs-auth';
  if (s.includes('connected') && !s.includes('fail')) return 'connected';
  if (s.includes('fail') || s.includes('error')) return 'failed';
  return 'unknown';
}

function sourceOf(name: string, cwd: string): ConnectorSource {
  if (name.startsWith('claude.ai ')) return 'account';
  if (name.startsWith('plugin:')) return 'plugin';
  const config = readJsonFile(CLAUDE_JSON);
  if (projectEntries(config, cwd).some(([, entry]) => entry?.mcpServers?.[name])) return 'local';
  if (readJsonFile(join(cwd, '.mcp.json'))?.mcpServers?.[name]) return 'project';
  return 'user';
}

function labelOf(name: string): string {
  if (name.startsWith('claude.ai ')) return name.slice('claude.ai '.length);
  // `plugin:<plugin>:<server>`: the server is what the user knows.
  if (name.startsWith('plugin:')) return name.split(':').at(-1) ?? name;
  return name;
}

const cache = new Map<string, { at: number; connectors: Connector[] }>();
const running = new Map<string, Promise<Connector[]>>();
const FRESH_MS = 60_000;

async function load(cwd: string): Promise<Connector[]> {
  const text = await claudeMcpList(cwd).catch(() => '');
  const connectors = parseMcpList(text).map(({ name, target, status }) => ({
    name,
    label: labelOf(name),
    source: sourceOf(name, cwd),
    target,
    state: stateOf(status),
    detail: status.replace(/^[^\p{L}]+/u, ''),
    toolPrefix: toolPrefix(name),
  }));
  markDuplicates(connectors);
  cache.set(cwd.toLowerCase(), { at: Date.now(), connectors });
  for (const listener of listeners) listener();
  return connectors;
}

/** The server a target reaches: `https://x/mcp (HTTP)` and `https://x/mcp/` are the same one. */
const endpoint = (target: string) => target.replace(/\s+\((HTTP|SSE)\)$/i, '').replace(/\/+$/, '').toLowerCase();

/**
 * A connector added by hand for a server another one already reaches, e.g.
 * `Facebook-ads` next to `claude.ai Meta-ads`: asking to sign in to it again
 * is noise, and the service may not even accept Claude Code's own sign-in.
 */
function markDuplicates(connectors: Connector[]) {
  const connected = new Map<string, string>();
  for (const c of connectors) if (c.state === 'connected' && /^https?:/i.test(c.target)) connected.set(endpoint(c.target), c.label);
  for (const c of connectors) {
    if (c.state === 'connected' || c.state === 'disabled') continue;
    const other = connected.get(endpoint(c.target));
    if (other) c.duplicateOf = other;
  }
}

const listeners = new Set<() => void>();

/** Called after every check of a project's connectors. */
export function onConnectorsChecked(listener: () => void) {
  listeners.add(listener);
}

/** The last check's result, without checking. */
export const cachedConnectors = (cwd: string): Connector[] => cache.get(cwd.toLowerCase())?.connectors ?? [];

/**
 * The project's connectors. Answers from the cache when there is one and checks
 * again in the background once it is a minute old; `fresh` waits for a new check.
 */
export async function projectConnectors(cwd: string, fresh = false): Promise<{ connectors: Connector[]; checkedAt: number }> {
  const key = cwd.toLowerCase();
  const refresh = () => {
    let job = running.get(key);
    if (!job) {
      job = load(cwd).finally(() => running.delete(key));
      running.set(key, job);
    }
    return job;
  };
  const hit = cache.get(key);
  if (hit && !fresh) {
    if (Date.now() - hit.at > FRESH_MS) refresh();
    return { connectors: hit.connectors, checkedAt: hit.at };
  }
  const connectors = await refresh();
  return { connectors, checkedAt: cache.get(key)?.at ?? Date.now() };
}

// ---- Changes -----------------------------------------------------------------------

const toggled = (list: unknown, name: string, on: boolean): string[] => {
  const names = (Array.isArray(list) ? list : []).filter((n) => n !== name);
  return on ? names : [...names, name];
};

/** On or off for this project only, whatever the server's scope. */
export function setConnectorEnabled(cwd: string, name: string, on: boolean) {
  if (sourceOf(name, cwd) === 'project') {
    // `.mcp.json` servers: Claude Code's own approve / reject lists.
    const file = join(cwd, '.claude', 'settings.local.json');
    const settings = readJsonFile(file) ?? {};
    settings.disabledMcpjsonServers = toggled(settings.disabledMcpjsonServers, name, on);
    const approved = toggled(settings.enabledMcpjsonServers, name, true);
    settings.enabledMcpjsonServers = on ? [...approved, name] : approved;
    writeJsonFile(file, settings);
  } else {
    // Read right before writing: Claude Code writes this file often.
    const config = readJsonFile(CLAUDE_JSON);
    if (!config) throw new Error(`Can't read ${CLAUDE_JSON}`);
    for (const entry of ownEntries(config, cwd)) entry.disabledMcpServers = toggled(entry.disabledMcpServers, name, on);
    writeJsonFile(CLAUDE_JSON, config);
  }
  // Shown at once; the next check says whether it connects.
  const hit = cache.get(cwd.toLowerCase());
  if (hit) {
    hit.connectors = hit.connectors.map((c) =>
      c.name === name ? { ...c, state: on ? 'unknown' : 'disabled', detail: on ? 'Checking…' : 'Disabled for this project' } : c,
    );
    hit.at = 0;
  }
}

/** Where an added server goes: this project only (Claude Code's local scope), or every project (user scope). */
export type ConnectorScope = 'project' | 'all';

/** Adds a server to `~/.claude.json`, the way `claude mcp add --scope local|user` does. */
export function addConnector(cwd: string, name: string, server: McpServerConfig, scope: ConnectorScope) {
  if (!NAME.test(name)) throw new Error('Use letters, digits, dots, dashes or underscores for the name');
  const known = cache.get(cwd.toLowerCase())?.connectors ?? [];
  if (known.some((c) => c.name === name)) throw new Error(`There is already a connector named ${name}`);
  const config = readJsonFile(CLAUDE_JSON);
  if (!config) throw new Error(`Can't read ${CLAUDE_JSON}`);
  const entry = toClaudeConfig(server);
  if (scope === 'all') {
    config.mcpServers = { ...config.mcpServers, [name]: entry };
  } else {
    for (const project of ownEntries(config, cwd)) project.mcpServers = { ...project.mcpServers, [name]: entry };
  }
  writeJsonFile(CLAUDE_JSON, config);
  // Listed at once; the next check says whether it connects.
  const hit = cache.get(cwd.toLowerCase());
  if (hit) {
    hit.connectors = [
      ...hit.connectors,
      { name, label: name, source: scope === 'all' ? 'user' : 'local', target: describeServer(server), state: 'unknown', detail: 'Checking…', toolPrefix: toolPrefix(name) },
    ];
    hit.at = 0;
  }
}

/** The entries of a server Orchia can change: every project's (user scope) and this project's (local scope). */
function ownServerEntries(config: any, cwd: string, name: string): any[] {
  return [config?.mcpServers?.[name], ...projectEntries(config, cwd).map(([, entry]) => entry?.mcpServers?.[name])].filter(Boolean);
}

/** A server's config, as Claude Code keeps it, when it is one Orchia can change. */
export function serverConfig(cwd: string, name: string): McpServerConfig | null {
  const entry = ownServerEntries(readJsonFile(CLAUDE_JSON), cwd, name)[0];
  return entry ? configFrom(entry) : null;
}

/** Sends this token with every request to the server: for services Claude Code can't sign in to. */
export function setConnectorToken(cwd: string, name: string, token: string) {
  const config = readJsonFile(CLAUDE_JSON);
  if (!config) throw new Error(`Can't read ${CLAUDE_JSON}`);
  const entries = ownServerEntries(config, cwd, name).filter((e) => e.type === 'http' || e.type === 'sse');
  if (!entries.length) throw new Error(`${name} can't take a token from here`);
  for (const entry of entries) entry.headers = { ...entry.headers, Authorization: `Bearer ${token}` };
  writeJsonFile(CLAUDE_JSON, config);
  // Shown at once; the next check says whether it connects.
  const hit = cache.get(cwd.toLowerCase());
  if (hit) {
    hit.connectors = hit.connectors.map((c) => (c.name === name ? { ...c, state: 'unknown', detail: 'Checking…' } : c));
    hit.at = 0;
  }
}

/** Removes a server added for every project or for this one. Others belong to the repo, a plugin or the account. */
export function removeConnector(cwd: string, name: string) {
  const config = readJsonFile(CLAUDE_JSON);
  if (!config) throw new Error(`Can't read ${CLAUDE_JSON}`);
  if (!ownServerEntries(config, cwd, name).length) throw new Error(`${name} can't be removed from here`);
  if (config.mcpServers?.[name]) delete config.mcpServers[name];
  // From every entry of the project: it is sometimes there once per drive-letter case.
  for (const [, entry] of projectEntries(config, cwd)) {
    if (entry?.mcpServers?.[name]) delete entry.mcpServers[name];
    if (Array.isArray(entry?.disabledMcpServers)) entry.disabledMcpServers = entry.disabledMcpServers.filter((n: string) => n !== name);
  }
  writeJsonFile(CLAUDE_JSON, config);
  const hit = cache.get(cwd.toLowerCase());
  if (hit) hit.connectors = hit.connectors.filter((c) => c.name !== name);
  signIns.delete(signInKey(cwd, name));
  for (const listener of listeners) listener();
}

/** The entry Claude Code keeps. On Windows, npx and the like are batch files that only start through cmd. */
function toClaudeConfig(server: McpServerConfig): Record<string, unknown> {
  if (server.type !== 'stdio') return { type: server.type, url: server.url, ...(server.headers ? { headers: server.headers } : {}) };
  const wrap = process.platform === 'win32' && /^(npx|bunx|pnpm|uvx|pipx)$/i.test(server.command);
  return {
    type: 'stdio',
    command: wrap ? 'cmd' : server.command,
    args: wrap ? ['/c', server.command, ...server.args] : server.args,
    env: server.env ?? {},
  };
}

// ---- Signing in ----------------------------------------------------------------------

export interface SignIn {
  /** The sign-in page, in case the browser did not open. */
  url: string | null;
  error: string | null;
  done: boolean;
}

const signIns = new Map<string, SignIn>();
const SIGN_IN_MS = 5 * 60_000;
const signInKey = (cwd: string, name: string) => `${cwd.toLowerCase()}\n${name}`;

/** Sign-ins started for this project: by server name, until the next check of the list after they end. */
export function signInsFor(cwd: string): Record<string, SignIn> {
  const prefix = `${cwd.toLowerCase()}\n`;
  return Object.fromEntries([...signIns].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key.slice(prefix.length), value]));
}

/**
 * Runs `claude mcp login <name>`: it opens the browser on the service's sign-in
 * page and waits for it to call back. It needs a terminal, so it runs in a pty.
 */
export function signIn(cwd: string, name: string, onSignedIn?: () => void) {
  // Goes through cmd on Windows: no quotes or shell characters in the name.
  if (!/^[\w .:-]{1,80}$/.test(name)) throw new Error('This connector can only sign in from a terminal: claude mcp login');
  const key = signInKey(cwd, name);
  if (signIns.get(key)?.done === false) return;
  const state: SignIn = { url: null, error: null, done: false };
  signIns.set(key, state);

  const command = process.env.ORCHIA_CLAUDE_CLI ?? 'claude';
  const [file, args] =
    process.platform === 'win32'
      ? [process.env.ComSpec ?? 'cmd.exe', `/d /s /c "${command} mcp login "${name}""`]
      : [command, ['mcp', 'login', name]];
  const proc = pty.spawn(file, args, { name: 'xterm-256color', cols: 400, rows: 30, cwd, env: cleanEnv() });
  let out = '';
  proc.onData((data) => {
    out = (out + data).slice(-20_000);
    state.url ??= out.match(/https:\/\/[^\s\x07\x1b]+/)?.[0] ?? null;
  });
  const timer = setTimeout(() => {
    state.error = 'Sign-in timed out. Try again.';
    proc.kill();
  }, SIGN_IN_MS);
  proc.onExit(({ exitCode }) => {
    clearTimeout(timer);
    const text = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    if (exitCode !== 0 && !state.error) {
      state.error = /dynamic client registration/i.test(text)
        ? // GitHub's server, for one: Claude Code can't sign in by itself, the server needs a token header.
          "This service needs an access token: Claude Code can't sign in to it."
        : (text.match(/Couldn't[^\r\n]*/)?.[0] ?? 'Sign-in did not finish.');
    }
    state.done = true;
    // Check the list again; a sign-in that worked stays known until that check is done, a failed one until the next try.
    projectConnectors(cwd, true)
      .then(({ connectors }) => {
        // The browser said yes but Claude Code got no token: say so, rather than just showing "Sign in" again.
        const after = connectors.find((c) => c.name === name);
        if (!state.error && after?.state === 'needs-auth') {
          state.error = after.duplicateOf
            ? `The sign-in didn't reach Claude Code. ${after.duplicateOf} already connects to this service: you can remove this one.`
            : "The sign-in didn't reach Claude Code. Try again, or sign in with /mcp in a Claude Code terminal.";
        }
      })
      .finally(() => {
        if (!state.error) onSignedIn?.();
        if (signIns.get(key) === state && !state.error) signIns.delete(key);
      });
  });
}

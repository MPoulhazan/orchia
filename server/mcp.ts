import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describeServer, NAME, type McpServerConfig } from './mcpSource.ts';
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
export type ConnectorState = 'connected' | 'needs-auth' | 'failed' | 'disabled' | 'pending' | 'unknown';

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
  const command = process.env.AGENTHUB_CLAUDE_CLI ?? 'claude';
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
  cache.set(cwd.toLowerCase(), { at: Date.now(), connectors });
  for (const listener of listeners) listener();
  return connectors;
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
export function signIn(cwd: string, name: string) {
  // Goes through cmd on Windows: no quotes or shell characters in the name.
  if (!/^[\w .:-]{1,80}$/.test(name)) throw new Error('This connector can only sign in from a terminal: claude mcp login');
  const key = signInKey(cwd, name);
  if (signIns.get(key)?.done === false) return;
  const state: SignIn = { url: null, error: null, done: false };
  signIns.set(key, state);

  const command = process.env.AGENTHUB_CLAUDE_CLI ?? 'claude';
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
          "This service doesn't let Claude Code sign in by itself. Add it again with an access token."
        : (text.match(/Couldn't[^\r\n]*/)?.[0] ?? 'Sign-in did not finish.');
    }
    state.done = true;
    // Check the list again; a sign-in that worked stays known until that check is done, a failed one until the next try.
    projectConnectors(cwd, true).finally(() => {
      if (signIns.get(key) === state && !state.error) signIns.delete(key);
    });
  });
}

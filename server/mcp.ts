import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { samePath } from './projects.ts';
import { cleanEnv } from './session.ts';
import { readJsonFile, writeJsonFile } from './skills.ts';

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
  return connectors;
}

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
    config.projects ??= {};
    const entries = projectEntries(config, cwd);
    if (!entries.length) {
      const key = cwd.replace(/\\/g, '/');
      config.projects[key] = {};
      entries.push([key, config.projects[key]]);
    }
    for (const [, entry] of entries) entry.disabledMcpServers = toggled(entry.disabledMcpServers, name, on);
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

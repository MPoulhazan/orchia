import { createReadStream, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

/**
 * How many tokens a project used, per day and model, added up on this computer from the usage
 * Claude Code writes in its transcripts. Cost is an estimate at API list price: on a subscription,
 * it is what the same work would cost through the API, not what was billed.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const USAGE_DAYS = 30;
/** Enough for a busy month; past it, the oldest transcripts are left out. */
const MAX_FILES = 600;

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export interface UsageRow extends TokenCounts {
  /** Local date, `YYYY-MM-DD`. */
  day: string;
  model: string;
  /** Conversations with at least one reply from this model that day; a subagent counts with its conversation. */
  sessions: number;
  /** Null when the model's price is unknown. */
  costUsd: number | null;
}

/** USD per million tokens. Cache writes are 1.25× input for 5 minutes and 2× for an hour. */
interface Price {
  input: number;
  output: number;
  cacheRead: number;
}

/** Longest prefix first, so `claude-opus-5-5` doesn't match `claude-opus-5`. */
const PRICES: [string, Price][] = [
  ['claude-fable-5-2', { input: 8, output: 40, cacheRead: 0.2 }],
  ['claude-mythos-5-2', { input: 8, output: 40, cacheRead: 0.2 }],
  ['claude-fable-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-mythos-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-fable-5', { input: 10, output: 50, cacheRead: 1 }],
  ['claude-mythos-5', { input: 10, output: 50, cacheRead: 1 }],
  ['claude-opus-5-5', { input: 4, output: 20, cacheRead: 0.2 }],
  ['claude-opus-5', { input: 5, output: 25, cacheRead: 0.5 }],
  ['claude-opus-4-8', { input: 5, output: 25, cacheRead: 0.5 }],
  ['claude-opus-4-7', { input: 5, output: 25, cacheRead: 0.5 }],
  ['claude-opus-4-6', { input: 5, output: 25, cacheRead: 0.5 }],
  ['claude-sonnet-5-5', { input: 2, output: 10, cacheRead: 0.1 }],
  ['claude-sonnet-5', { input: 2, output: 10, cacheRead: 0.2 }],
  ['claude-sonnet-4-6', { input: 3, output: 15, cacheRead: 0.3 }],
  ['claude-haiku-5-5', { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  ['claude-haiku-4-5', { input: 1, output: 5, cacheRead: 0.1 }],
];

export function priceOf(model: string): Price | null {
  return PRICES.find(([prefix]) => model === prefix || model.startsWith(`${prefix}-`) || model.startsWith(`${prefix}[`))?.[1] ?? null;
}

export function costOf(model: string, t: TokenCounts): number | null {
  const p = priceOf(model);
  if (!p) return null;
  const usd = t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead + t.cacheWrite5m * p.input * 1.25 + t.cacheWrite1h * p.input * 2;
  return usd / 1_000_000;
}

/** One reply from Claude: its day, model and tokens. */
export interface Reply extends TokenCounts {
  day: string;
  model: string;
}

/**
 * What one transcript used, by message id. Claude Code writes one line per content block, each with
 * the same usage, and a resumed conversation can carry the earlier replies again: ids count each once.
 */
export type FileUsage = Map<string, Reply>;

export const emptyUsage = (): FileUsage => new Map();

const zero = (): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

export function localDay(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Reads one transcript line into `usage`. Only assistant replies carry usage. */
export function addUsageLine(usage: FileUsage, line: string) {
  if (!line.includes('"usage"') || !line.includes('"type":"assistant"')) return;
  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  const msg = entry.message;
  const u = msg?.usage;
  const model = msg?.model;
  if (entry.type !== 'assistant' || !u || typeof model !== 'string' || model.startsWith('<')) return;
  const at = Date.parse(entry.timestamp);
  if (!Number.isFinite(at)) return;
  const id = typeof msg.id === 'string' ? msg.id : typeof entry.requestId === 'string' ? entry.requestId : typeof entry.uuid === 'string' ? entry.uuid : null;
  if (!id || usage.has(id)) return;
  const write = n(u.cache_creation_input_tokens);
  const write1h = Math.min(write, n(u.cache_creation?.ephemeral_1h_input_tokens));
  usage.set(id, {
    day: localDay(at),
    model,
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cacheWrite5m: write - write1h,
    cacheWrite1h: write1h,
  });
}

/** Adds the conversations up into one row per day and model, the most recent day first. */
export function usageRows(files: { conversation: string; usage: FileUsage }[], sinceDay: string): UsageRow[] {
  const rows = new Map<string, UsageRow>();
  const conversations = new Map<string, Set<string>>();
  const counted = new Set<string>();
  for (const { conversation, usage } of files) {
    for (const [id, r] of usage) {
      if (r.day < sinceDay || counted.has(id)) continue;
      counted.add(id);
      const key = `${r.day}|${r.model}`;
      const row = rows.get(key) ?? { day: r.day, model: r.model, sessions: 0, costUsd: null, ...zero() };
      row.input += r.input;
      row.output += r.output;
      row.cacheRead += r.cacheRead;
      row.cacheWrite5m += r.cacheWrite5m;
      row.cacheWrite1h += r.cacheWrite1h;
      const seen = conversations.get(key) ?? new Set<string>();
      seen.add(conversation);
      conversations.set(key, seen);
      row.sessions = seen.size;
      rows.set(key, row);
    }
  }
  return [...rows.values()]
    .map((r) => ({ ...r, costUsd: costOf(r.model, r) }))
    .sort((a, b) => b.day.localeCompare(a.day) || a.model.localeCompare(b.model));
}

// ---- Reading the files -------------------------------------------------------

const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects');
/** A transcript is only read again once it changed. */
const parsed = new Map<string, { mtimeMs: number; size: number; usage: FileUsage }>();

function transcriptDir(cwd: string): string | null {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  try {
    const found = readdirSync(CLAUDE_PROJECTS).find((d) => d.toLowerCase() === name);
    return found ? join(CLAUDE_PROJECTS, found) : null;
  } catch {
    return null;
  }
}

async function readUsage(file: string, stat: { mtimeMs: number; size: number }): Promise<FileUsage> {
  const known = parsed.get(file);
  if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) return known.usage;
  const usage = emptyUsage();
  for await (const line of createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })) addUsageLine(usage, line);
  parsed.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, usage });
  return usage;
}

/** Conversations' transcripts, and their subagents' transcripts, which Claude Code keeps in `<id>/subagents/`. */
function transcriptFiles(dir: string): { f: string; conversation: string }[] {
  const files: { f: string; conversation: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push({ f: join(dir, entry.name), conversation: entry.name.replace(/\.jsonl$/, '') });
    else if (entry.isDirectory()) {
      try {
        for (const f of readdirSync(join(dir, entry.name, 'subagents'))) {
          if (f.endsWith('.jsonl')) files.push({ f: join(dir, entry.name, 'subagents', f), conversation: entry.name });
        }
      } catch {
        // No subagents in this conversation.
      }
    }
  }
  return files;
}

export async function projectUsage(cwd: string, now = Date.now(), days = USAGE_DAYS): Promise<UsageRow[]> {
  const dir = transcriptDir(cwd);
  if (!dir) return [];
  const since = now - days * DAY_MS;
  const files = transcriptFiles(dir)
    .flatMap(({ f, conversation }) => {
      try {
        return [{ f, conversation, stat: statSync(f) }];
      } catch {
        return [];
      }
    })
    .filter(({ stat }) => stat.mtimeMs >= since)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .slice(0, MAX_FILES);
  const usages: { conversation: string; usage: FileUsage }[] = [];
  for (const { f, conversation, stat } of files) {
    const usage = await readUsage(f, stat).catch(() => null);
    if (usage) usages.push({ conversation, usage });
  }
  return usageRows(usages, localDay(since + DAY_MS));
}

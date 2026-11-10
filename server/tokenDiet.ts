import { createReadStream, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { redactSecrets } from './secrets.ts';

/**
 * Where a project's tokens go, worked out on this computer by fixed rules from Claude Code's
 * transcripts and the project's files. No model is called and nothing is sent anywhere.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 30 * DAY_MS;
const MAX_SESSIONS = 40;

/** Below this, a connector nobody called may just not have been needed yet. */
export const MIN_SESSIONS_FOR_CONNECTORS = 5;
/** About 5,000 tokens, read at the start of every session. */
export const HEAVY_MEMORY_BYTES = 20_000;
export const MANY_AUTO_COMPACTS = 2;
export const SHORT_SESSION_PROMPTS = 3;
export const MIN_SHORT_MAX_SESSIONS = 3;
/** A session touched in the last hour may not be over, so it doesn't count as short yet. */
export const SETTLED_AFTER_MS = 60 * 60 * 1000;
export const MIN_REPEAT_SESSIONS = 3;
export const MIN_REPEAT_LENGTH = 15;
const MAX_REPEATS_SHOWN = 3;

/** What one transcript says, reduced to what the rules read. */
export interface TranscriptFacts {
  id: string;
  lastAt: number;
  prompts: string[];
  mcpTools: string[];
  autoCompacts: number;
  model: string | null;
  effort: string | null;
  /** Tool names Claude Code listed as deferred: only their names are sent until one is looked up. */
  deferredTools: string[];
  /** Server name → length of the instructions it sends with every session. */
  mcpInstructions: Record<string, number>;
}

/** A connector nobody called, with what it costs every session when that is known. */
export interface UnusedConnector {
  /** Claude Code's name for it, e.g. `claude.ai Sentry`: what turning it off takes. */
  name: string;
  label: string;
  tools: number | null;
  /** About this many tokens in every session: its tools' names and its instructions. */
  tokens: number | null;
}

export interface DietFinding {
  id: string;
  title: string;
  detail: string;
  /** What to do about it. */
  action: string;
  /** For `unused-connectors`: they can be turned off from the finding. */
  connectors?: UnusedConnector[];
}

export interface MemoryFile {
  label: string;
  bytes: number;
}

export interface DietInput {
  sessions: TranscriptFacts[];
  /** Connected connectors, with the prefix of their tools' names (`mcp__<prefix>__tool`). */
  connectors: { name: string; label: string; prefix: string }[];
  memoryFiles: MemoryFile[];
  now: number;
}

export const emptyFacts = (id: string): TranscriptFacts => ({
  id,
  lastAt: 0,
  prompts: [],
  mcpTools: [],
  autoCompacts: 0,
  model: null,
  effort: null,
  deferredTools: [],
  mcpInstructions: {},
});

/** Text the user wrote in this entry; null for a tool result, a command or something Claude Code added itself. */
function promptText(entry: any): string | null {
  if (entry.isMeta || entry.isSidechain || entry.isCompactSummary) return null;
  if (entry.origin?.kind === 'task-notification' || entry.promptSource === 'system') return null;
  const content = entry.message?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content) && content.every((b: any) => b.type !== 'tool_result')
        ? content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ')
        : '';
  const trimmed = text.trim();
  return !trimmed || /^[<\/!]/.test(trimmed) ? null : trimmed;
}

/** Reads one transcript line into `facts`. Most lines are skipped without being parsed: transcripts get large. */
export function addLine(facts: TranscriptFacts, line: string) {
  if (line.includes('"deferred_tools_delta"') || line.includes('"mcp_instructions_delta"')) return addAttachment(facts, line);
  if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"') && !line.includes('"compact_boundary"')) return;
  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  const at = Date.parse(entry.timestamp);
  if (at > facts.lastAt) facts.lastAt = at;
  if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
    if (entry.compactMetadata?.trigger === 'auto') facts.autoCompacts++;
  } else if (entry.type === 'user') {
    const prompt = promptText(entry);
    if (prompt) facts.prompts.push(prompt);
  } else if (entry.type === 'assistant' && !entry.isSidechain) {
    const model = entry.message?.model;
    if (typeof model === 'string' && !model.startsWith('<')) {
      facts.model = model;
      if (typeof entry.effort === 'string') facts.effort = entry.effort;
    }
    for (const block of Array.isArray(entry.message?.content) ? entry.message.content : []) {
      if (block.type === 'tool_use' && typeof block.name === 'string' && block.name.startsWith('mcp__') && !facts.mcpTools.includes(block.name)) {
        facts.mcpTools.push(block.name);
      }
    }
  }
}

/** What Claude Code tells the model about connectors: their tools' names and their instructions, as they change. */
function addAttachment(facts: TranscriptFacts, line: string) {
  let a: any;
  try {
    a = JSON.parse(line).attachment;
  } catch {
    return;
  }
  const names = (list: unknown): string[] => (Array.isArray(list) ? list.filter((n): n is string => typeof n === 'string') : []);
  if (a?.type === 'deferred_tools_delta') {
    const removed = new Set(names(a.removedNames));
    const kept = facts.deferredTools.filter((n) => !removed.has(n));
    const known = new Set(kept);
    facts.deferredTools = [...kept, ...names(a.addedNames).filter((n) => !known.has(n))];
  } else if (a?.type === 'mcp_instructions_delta') {
    for (const name of names(a.removedNames)) delete facts.mcpInstructions[name];
    names(a.addedNames).forEach((name, i) => {
      const block = a.addedBlocks?.[i];
      facts.mcpInstructions[name] = typeof block === 'string' ? block.length : 0;
    });
  }
}

/** About 4 characters a token. */
const tokensOf = (chars: number) => Math.round(chars / 4);

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function unusedConnectors({ sessions, connectors }: DietInput): DietFinding[] {
  if (sessions.length < MIN_SESSIONS_FOR_CONNECTORS) return [];
  const called = sessions.flatMap((s) => s.mcpTools);
  // What the latest session that listed deferred tools carried; unknown when tools are all loaded up front.
  const latest = [...sessions].sort((a, b) => b.lastAt - a.lastAt).find((s) => s.deferredTools.length);
  const unused: UnusedConnector[] = connectors
    .filter((c) => !called.some((tool) => tool.startsWith(`mcp__${c.prefix}__`)))
    .map((c) => {
      if (!latest) return { name: c.name, label: c.label, tools: null, tokens: null };
      const tools = latest.deferredTools.filter((t) => t.startsWith(`mcp__${c.prefix}__`));
      const chars = tools.reduce((sum, t) => sum + t.length + 1, 0) + (latest.mcpInstructions[c.name] ?? 0);
      return { name: c.name, label: c.label, tools: tools.length, tokens: tokensOf(chars) };
    })
    .sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0) || a.label.localeCompare(b.label));
  if (!unused.length) return [];
  const total = unused.reduce((sum, c) => sum + (c.tokens ?? 0), 0);
  return [
    {
      id: 'unused-connectors',
      title: `${plural(unused.length, 'connector')} never called`,
      detail:
        `Connected here, but not called in the last ${plural(sessions.length, 'session')}.` +
        (total ? ` Together, about ${total.toLocaleString('en-US')} tokens at the start of every session.` : ''),
      action: 'Untick what this project still needs, then turn off the rest. Only this project changes, and you can undo it.',
      connectors: unused,
    },
  ];
}

function heavyMemory({ memoryFiles }: DietInput): DietFinding[] {
  return memoryFiles
    .filter((f) => f.bytes >= HEAVY_MEMORY_BYTES)
    .map((f) => ({
      id: `heavy-memory:${f.label}`,
      title: `${f.label} is heavy`,
      detail: `${Math.round(f.bytes / 1000)} KB, about ${Math.round(f.bytes / 4).toLocaleString('en-US')} tokens read at the start of every session.`,
      action: 'Keep the rules that apply every time, and move the rest to files Claude reads when it needs them, or to skills.',
    }));
}

function repeatedAutoCompacts({ sessions }: DietInput): DietFinding[] {
  const long = sessions.filter((s) => s.autoCompacts >= MANY_AUTO_COMPACTS);
  if (!long.length) return [];
  return [
    {
      id: 'auto-compacts',
      title: 'Sessions that outgrow their context',
      detail: `${long.length} of the last ${plural(sessions.length, 'session')} compacted automatically ${MANY_AUTO_COMPACTS} times or more (up to ${Math.max(...long.map((s) => s.autoCompacts))}).`,
      action: 'Split long work into lots with /lots: each lot starts with a fresh context.',
    },
  ];
}

function maxEffortOnShortSessions({ sessions, now }: DietInput): DietFinding[] {
  const short = sessions.filter(
    (s) => s.prompts.length > 0 && s.prompts.length <= SHORT_SESSION_PROMPTS && s.effort === 'max' && /opus/i.test(s.model ?? '') && now - s.lastAt >= SETTLED_AFTER_MS,
  );
  if (short.length < MIN_SHORT_MAX_SESSIONS) return [];
  return [
    {
      id: 'opus-max-short',
      title: 'Opus at max effort on short sessions',
      detail: `${plural(short.length, 'session')} of ${SHORT_SESSION_PROMPTS} prompts or fewer ran on Opus at max effort.`,
      action: "For quick tasks, pick a lower effort in the session's model menu.",
    },
  ];
}

const normalize = (prompt: string) => prompt.toLowerCase().replace(/\s+/g, ' ').trim();
const ORCHIA_PROMPT = /^(continue the plan with lot|restate the plan|work on github issue)/;

function repeatedPrompts({ sessions }: DietInput): DietFinding[] {
  const seen = new Map<string, { text: string; sessions: Set<string> }>();
  for (const session of sessions) {
    for (const prompt of session.prompts) {
      const key = normalize(prompt);
      if (key.length < MIN_REPEAT_LENGTH || ORCHIA_PROMPT.test(key)) continue;
      const entry = seen.get(key) ?? { text: prompt, sessions: new Set<string>() };
      entry.sessions.add(session.id);
      seen.set(key, entry);
    }
  }
  return [...seen.values()]
    .filter((e) => e.sessions.size >= MIN_REPEAT_SESSIONS)
    .sort((a, b) => b.sessions.size - a.sessions.size)
    .slice(0, MAX_REPEATS_SHOWN)
    .map((e) => {
      const text = redactSecrets(e.text.replace(/\s+/g, ' '));
      return {
        id: `repeat:${normalize(e.text).slice(0, 60)}`,
        title: `Same prompt in ${e.sessions.size} sessions`,
        detail: `"${text.length > 90 ? `${text.slice(0, 89)}…` : text}"`,
        action: 'Make it a skill or a slash command, so it is one short word to type.',
      };
    });
}

export function dietFindings(input: DietInput): DietFinding[] {
  return [...heavyMemory(input), ...unusedConnectors(input), ...repeatedAutoCompacts(input), ...maxEffortOnShortSessions(input), ...repeatedPrompts(input)];
}

// ---- Reading the files -------------------------------------------------------

const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects');
/** A transcript is only read again once it changed. */
const parsed = new Map<string, { mtimeMs: number; size: number; facts: TranscriptFacts }>();

/** Claude Code names a project's transcript folder after its path, every other character as `-`. */
function transcriptDir(cwd: string): string | null {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  try {
    const found = readdirSync(CLAUDE_PROJECTS).find((d) => d.toLowerCase() === name);
    return found ? join(CLAUDE_PROJECTS, found) : null;
  } catch {
    return null;
  }
}

async function readFacts(file: string, id: string, stat: { mtimeMs: number; size: number }): Promise<TranscriptFacts> {
  const known = parsed.get(file);
  if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) return known.facts;
  const facts = emptyFacts(id);
  for await (const line of createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })) addLine(facts, line);
  parsed.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, facts });
  return facts;
}

/** The project's most recent conversations, with at least one prompt. */
async function recentSessions(cwd: string, now: number): Promise<TranscriptFacts[]> {
  const dir = transcriptDir(cwd);
  if (!dir) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, stat: statSync(join(dir, f)) }))
    .filter(({ stat }) => now - stat.mtimeMs <= WINDOW_MS)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .slice(0, MAX_SESSIONS);
  const facts: TranscriptFacts[] = [];
  for (const { f, stat } of files) {
    const one = await readFacts(join(dir, f), f.replace(/\.jsonl$/, ''), stat).catch(() => null);
    if (one?.prompts.length) facts.push(one);
  }
  return facts;
}

function memoryFiles(cwd: string): MemoryFile[] {
  const candidates = [
    { label: 'CLAUDE.md', path: join(cwd, 'CLAUDE.md') },
    { label: '.claude/CLAUDE.md', path: join(cwd, '.claude', 'CLAUDE.md') },
    { label: '~/.claude/CLAUDE.md', path: join(homedir(), '.claude', 'CLAUDE.md') },
  ];
  return candidates.flatMap(({ label, path }) => {
    try {
      return [{ label, bytes: statSync(path).size }];
    } catch {
      return [];
    }
  });
}

export async function projectDiet(cwd: string, connectors: DietInput['connectors'], now = Date.now()): Promise<{ findings: DietFinding[]; sessions: number }> {
  const sessions = await recentSessions(cwd, now);
  return { findings: dietFindings({ sessions, connectors, memoryFiles: memoryFiles(cwd), now }), sessions: sessions.length };
}

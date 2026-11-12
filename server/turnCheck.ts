/**
 * What a finished turn proves: which checks Claude ran (tests, types, build,
 * lint, push) and whether the last run of each passed, read from the shell
 * commands of the turn. Also spots a turn going in circles (the same command
 * failing again and again) and a reply that ends on a question for the user.
 */

export type CheckKind = 'tests' | 'types' | 'build' | 'lint' | 'push';

export interface TurnCheck {
  kind: CheckKind;
  ok: boolean;
}

const KINDS: [CheckKind, RegExp][] = [
  ['push', /\bgit\s+push\b/],
  ['types', /\btsc\b|\b(typecheck|type-check)\b|\bmypy\b|\bpyright\b/],
  ['lint', /\beslint\b|\bbiome\s+(check|lint)\b|\bruff\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?lint\b/],
  ['build', /\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b|\bvite\s+build\b|\bnext\s+build\b|\bcargo\s+build\b|\bgo\s+build\b/],
  [
    'tests',
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bnpx\s+(vitest|jest|playwright)\b|\bvitest\b|\bjest\b|\bpytest\b|\bnode\s+(--import\s+\S+\s+)?--test\b|\bgo\s+test\b|\bcargo\s+test\b|\bplaywright\s+test\b/,
  ],
];

/** The checks a shell command runs, e.g. `npm run typecheck && npm test` → types, tests. */
export function checksIn(command: unknown): CheckKind[] {
  if (typeof command !== 'string') return [];
  return KINDS.filter(([, re]) => re.test(command)).map(([kind]) => kind);
}

/** A shell call that Claude Code reported as done but that exited with an error. */
export function shellFailed(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false;
  const r = response as Record<string, unknown>;
  const code = r.exitCode ?? r.exit_code ?? r.returnCode ?? r.code;
  return (typeof code === 'number' && code !== 0) || r.interrupted === true || r.is_error === true;
}

/** How many times the same command may fail in one turn before the session looks stuck. */
export const STUCK_AFTER = 3;

/** Tracks the shell commands of one turn. */
export class TurnChecks {
  private results = new Map<CheckKind, boolean>();
  private failures = new Map<string, number>();
  /** "`npm test` failed 3 times": set while the same command keeps failing. */
  stuck: string | null = null;

  reset() {
    this.results.clear();
    this.failures.clear();
    this.stuck = null;
  }

  /** Records one shell call; returns true when `stuck` changed. */
  record(command: unknown, ok: boolean): boolean {
    if (typeof command !== 'string' || !command.trim()) return false;
    for (const kind of checksIn(command)) this.results.set(kind, ok);
    const key = command.trim().replace(/\s+/g, ' ');
    const before = this.stuck;
    if (ok) {
      this.failures.delete(key);
      if (this.stuck && this.stuck.startsWith(`\`${short(key)}\``)) this.stuck = null;
    } else {
      const n = (this.failures.get(key) ?? 0) + 1;
      this.failures.set(key, n);
      if (n >= STUCK_AFTER) this.stuck = `\`${short(key)}\` failed ${n} times`;
    }
    return before !== this.stuck;
  }

  /** The last result of each check, in a stable order. */
  list(): TurnCheck[] {
    const order: CheckKind[] = ['tests', 'types', 'lint', 'build', 'push'];
    return order.filter((k) => this.results.has(k)).map((kind) => ({ kind, ok: this.results.get(kind)! }));
  }
}

function short(command: string): string {
  return command.length > 60 ? `${command.slice(0, 59)}…` : command;
}

/**
 * The question a reply ends on, e.g. "Want me to push to main?", or null.
 * Only the last paragraph counts, outside code: a question asked in passing
 * earlier in the reply doesn't make Claude wait.
 */
export function closingQuestion(message: unknown): string | null {
  if (typeof message !== 'string') return null;
  const paragraphs = message
    .replace(/```[\s\S]*?(```|$)/g, '\n\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const last = paragraphs.at(-1);
  if (!last) return null;
  const text = last
    .split('\n')
    .map((l) => l.replace(/^\s*([-*+]|\d+[.)]|>|#{1,6})\s+/, '').trim())
    .join(' ')
    .replace(/(\*\*|__|\*|_|`)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/\?["')\]]?$/.test(text)) return null;
  // The last sentence holds the question; earlier ones are context.
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]?/g) ?? [text];
  const question = sentences.at(-1)!.trim();
  return question.length > 180 ? `${question.slice(0, 179)}…` : question;
}

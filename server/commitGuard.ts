import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { findSecrets, type SecretHit } from './secrets.ts';

/**
 * Stops Claude from committing or pushing a secret. Orchia sees each shell command Claude is
 * about to run (PreToolUse); for a `git commit` or `git push`, it reads what would go into
 * git and looks for secrets with the same fixed-prefix rules as for the model, so a hit is
 * almost always real. Only Claude's commands go through here: a commit typed by hand doesn't.
 */

const run = promisify(execFile);

/** `git commit -m …`, `git -C web push`, `git add -A && git commit …`. */
const GIT_ACTION = /\bgit(?:\s+-[Cc]\s+\S+)*\s+(commit|push)\b/;
/** The command stages more than what is staged now: `git add …`, or `git commit -a` / `-am` / `--all`. */
const STAGES_MORE = /\bgit(?:\s+-[Cc]\s+\S+)*\s+add\b|\bgit\s+commit\b[^|;&\n]*\s(?:--all\b|-[A-Za-z]*a[A-Za-z]*\b)/;
/** Untracked files bigger than this are not read; nor are more than this many of them. */
const MAX_FILE_BYTES = 1_000_000;
const MAX_UNTRACKED = 200;

export interface CommitSecret {
  hit: SecretHit;
  file: string;
}

export interface BlockedCommit {
  action: 'commit' | 'push';
  secrets: CommitSecret[];
}

/** The secrets a shell command's commit or push would add to git; null when there are none. */
export async function secretsInGitCommand(command: unknown, cwd: string): Promise<BlockedCommit | null> {
  if (typeof command !== 'string') return null;
  const action = command.match(GIT_ACTION)?.[1] as BlockedCommit['action'] | undefined;
  if (!action) return null;
  const added = action === 'push' ? await pushedLines(cwd) : await committedLines(cwd, STAGES_MORE.test(command));
  const secrets = new Map<string, CommitSecret>();
  for (const { file, text } of added) {
    for (const hit of findSecrets(text)) if (!secrets.has(hit.fingerprint)) secrets.set(hit.fingerprint, { hit, file });
  }
  return secrets.size ? { action, secrets: [...secrets.values()] } : null;
}

/** What Claude is told: which secret, where, and how to commit without it. Masked values only. */
export function blockedReason(blocked: BlockedCommit): string {
  const list = blocked.secrets.map((s) => `${article(s.hit.label)} ${s.hit.label} (${s.hit.masked}) in ${s.file}`).join(', ');
  const fix =
    blocked.action === 'push'
      ? 'It is already in a local commit: remove it from the code, rewrite the commit that added it (amend, or an interactive rebase for an older one), then push.'
      : 'Remove it from the code, read it from an environment variable or an ignored .env file instead, stage the change and commit again.';
  return (
    `Orchia blocked this git ${blocked.action}: it would add ${list}. ${fix} ` +
    `If it is not a real secret, tell the user: they can commit it themselves.`
  );
}

function article(label: string): string {
  return /^[AEIOU]/.test(label) ? 'an' : 'a';
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd, maxBuffer: 50 * 1024 * 1024, timeout: 15000, windowsHide: true });
    return stdout;
  } catch {
    return '';
  }
}

/** Staged changes; with `more`, also unstaged ones and untracked files, which the command is about to add. */
async function committedLines(cwd: string, more: boolean): Promise<{ file: string; text: string }[]> {
  const lines = addedLines(await git(cwd, ['diff', '--cached', '-U0', '--no-color', '--no-ext-diff']));
  if (!more) return lines;
  lines.push(...addedLines(await git(cwd, ['diff', '-U0', '--no-color', '--no-ext-diff'])));
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean).slice(0, MAX_UNTRACKED);
  for (const file of untracked) {
    try {
      const path = join(cwd, file);
      if ((await stat(path)).size > MAX_FILE_BYTES) continue;
      const text = await readFile(path, 'utf8');
      if (!text.includes('\0')) lines.push({ file, text });
    } catch {}
  }
  return lines;
}

/** Every commit the push would send, not just the end result: a secret added then removed is still in history. */
async function pushedLines(cwd: string): Promise<{ file: string; text: string }[]> {
  const upstream = (await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
  const base = upstream || ((await git(cwd, ['rev-parse', '--verify', '--quiet', 'origin/HEAD'])).trim() ? 'origin/HEAD' : '');
  if (!base) return [];
  return addedLines(await git(cwd, ['log', '-p', '-U0', '--no-color', '--no-ext-diff', '--format=', `${base}..HEAD`]));
}

/** The lines a diff adds, grouped by file. */
function addedLines(diff: string): { file: string; text: string }[] {
  const byFile = new Map<string, string[]>();
  let file = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) file = line.slice(4).replace(/^b\//, '').trim();
    else if (line.startsWith('+') && file && file !== '/dev/null') {
      const lines = byFile.get(file) ?? [];
      lines.push(line.slice(1));
      byFile.set(file, lines);
    }
  }
  return [...byFile].map(([f, lines]) => ({ file: f, text: lines.join('\n') }));
}

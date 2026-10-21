import { execFile } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { samePath } from './projects.ts';

/**
 * "Own copy": a session that works in its own git worktree, so parallel
 * sessions never edit the same files. Orchia creates the worktree itself,
 * where Claude Code puts its own (`.claude/worktrees/<name>`, branch
 * `worktree-<name>`), from the project's current HEAD so unpushed commits come
 * along. Merging back and discarding also happen here.
 */

export interface SessionCopy {
  /** The worktree folder the session runs in. */
  path: string;
  /** Its branch, e.g. `worktree-session-3`. */
  branch: string;
  /** The project's branch when the copy was made; merges go back into it. */
  base: string;
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

const tryGit = (cwd: string, args: string[]) => git(cwd, args).then((out) => out.trim(), () => null);

/**
 * Whether sessions of this project can get their own copy: the folder is the
 * root of a git repository with at least one commit, on a branch.
 */
export async function canCopy(projectPath: string): Promise<boolean> {
  const root = await tryGit(projectPath, ['rev-parse', '--show-toplevel']);
  if (!root || !samePath(root, projectPath)) return false;
  return (await tryGit(projectPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) !== null && (await tryGit(projectPath, ['rev-parse', '--verify', '--quiet', 'HEAD'])) !== null;
}

/** "Session 3" → "session-3". */
function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'session'
  );
}

/** Creates the worktree for a new session named `name`. */
export async function createCopy(projectPath: string, name: string): Promise<SessionCopy> {
  const base = await git(projectPath, ['symbolic-ref', '--short', 'HEAD']).then((b) => b.trim());
  const dir = join(projectPath, '.claude', 'worktrees');
  let id = slug(name);
  for (let n = 2; existsSync(join(dir, id)) || (await tryGit(projectPath, ['rev-parse', '--verify', '--quiet', `refs/heads/worktree-${id}`])); n++) {
    id = `${slug(name)}-${n}`;
  }
  await hideWorktrees(projectPath);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, id);
  const branch = `worktree-${id}`;
  await git(projectPath, ['worktree', 'add', '-b', branch, path, 'HEAD']);
  copyEnvFiles(projectPath, path);
  return { path, branch, base };
}

/** Keeps `.claude/worktrees/` out of `git status` in the main checkout, without touching tracked files. */
async function hideWorktrees(projectPath: string) {
  if ((await tryGit(projectPath, ['check-ignore', '-q', '.claude/worktrees/x'])) !== null) return;
  const gitDir = await git(projectPath, ['rev-parse', '--git-common-dir']).then((d) => join(projectPath, d.trim()));
  const exclude = join(gitDir, 'info', 'exclude');
  mkdirSync(join(gitDir, 'info'), { recursive: true });
  const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  appendFileSync(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}# Orchia: sessions working in their own copy\n/.claude/worktrees/\n`);
}

/** A fresh checkout lacks ignored files such as `.env`; copy the ones at the root. */
function copyEnvFiles(from: string, to: string) {
  for (const name of readdirSync(from)) {
    if (!/^\.env(\..+)?$/.test(name) || existsSync(join(to, name))) continue;
    try {
      copyFileSync(join(from, name), join(to, name));
    } catch {
      // A folder, or unreadable: not worth failing the session over.
    }
  }
}

// ---- Review and merge -------------------------------------------------------------

export interface CopyChanges {
  /** Unified diff of everything the copy changed since it was made, uncommitted work and new files included. */
  diff: string;
  files: { path: string; added: number | null; removed: number | null; isNew: boolean }[];
  /** Commits on the copy's branch. */
  commits: number;
  /** Commits that landed on the base branch since the copy was made. */
  behind: number;
  /** The copy and the base branch changed the same lines (committed work only). */
  conflicts: boolean;
  /** Why "Merge" cannot go right now, in words; null when it can. */
  blocked: string | null;
}

const MAX_DIFF = 2 * 1024 * 1024;
const MAX_NEW_FILE = 200 * 1024;

export async function copyChanges(projectPath: string, copy: SessionCopy): Promise<CopyChanges> {
  const cwd = copy.path;
  const fork = (await git(cwd, ['merge-base', copy.base, 'HEAD'])).trim();
  const [diff, numstat, untracked, commits, behind, current] = await Promise.all([
    git(cwd, ['diff', '--no-color', '--no-ext-diff', fork]),
    git(cwd, ['diff', '--numstat', fork]),
    git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
    git(cwd, ['rev-list', '--count', `${fork}..HEAD`]),
    git(cwd, ['rev-list', '--count', `${fork}..${copy.base}`]),
    tryGit(projectPath, ['symbolic-ref', '--short', 'HEAD']),
  ]);

  const files: CopyChanges['files'] = numstat
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [a, r, ...path] = line.split('\t');
      return { path: path.join('\t'), added: a === '-' ? null : Number(a), removed: r === '-' ? null : Number(r), isNew: false };
    });
  let text = diff;
  for (const path of untracked.split('\0').filter(Boolean)) {
    const body = newFileDiff(cwd, path);
    files.push({ path, added: body.lines, removed: 0, isNew: true });
    text += body.text;
  }

  // Committed work only: git 2.26 has no merge-tree --write-tree, the old form prints conflict markers.
  const behindCount = Number(behind.trim());
  const conflicts = behindCount > 0 && Number(commits.trim()) > 0 && (await git(cwd, ['merge-tree', fork, copy.base, 'HEAD'])).includes('<<<<<<<');
  return {
    diff: text.length > MAX_DIFF ? text.slice(0, MAX_DIFF) : text,
    files,
    commits: Number(commits.trim()),
    behind: behindCount,
    conflicts,
    blocked: current !== copy.base ? `The project folder is on ${current ?? 'a detached HEAD'}, not ${copy.base}. Switch it back to merge.` : null,
  };
}

function newFileDiff(cwd: string, path: string): { text: string; lines: number | null } {
  let content: string;
  try {
    content = readFileSync(join(cwd, path)).subarray(0, MAX_NEW_FILE).toString('utf8');
  } catch {
    return { text: '', lines: null };
  }
  if (content.includes('\0')) return { text: `diff --git a/${path} b/${path}\nnew file mode 100644\nBinary files /dev/null and b/${path} differ\n`, lines: null };
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return {
    text: `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`,
    lines: lines.length,
  };
}

export class MergeConflictError extends Error {}

/**
 * Commits what is left in the copy, then merges its branch into the base branch
 * in the project folder. A conflict is aborted, leaving both untouched.
 */
export async function mergeCopy(projectPath: string, copy: SessionCopy, message: string) {
  const current = await tryGit(projectPath, ['symbolic-ref', '--short', 'HEAD']);
  if (current !== copy.base) throw new Error(`The project folder is on ${current ?? 'a detached HEAD'}, not ${copy.base}. Switch it back to merge.`);
  if ((await git(copy.path, ['status', '--porcelain'])).trim()) {
    await git(copy.path, ['add', '-A']);
    await git(copy.path, ['commit', '-q', '-m', message]);
  }
  try {
    // Fast-forwards when the base branch has not moved; the message names the session otherwise.
    await git(projectPath, ['merge', '--no-edit', '-m', `Merge ${message} (${copy.branch})`, copy.branch]);
  } catch (err) {
    const conflicted = await tryGit(projectPath, ['diff', '--name-only', '--diff-filter=U']);
    if (conflicted) {
      await tryGit(projectPath, ['merge', '--abort']);
      throw new MergeConflictError(`${copy.base} changed the same lines: ${conflicted.split('\n').join(', ')}`);
    }
    throw err;
  }
}

/** Nothing to lose: no commits on the branch and no uncommitted or new files. */
export async function copyIsEmpty(copy: SessionCopy): Promise<boolean> {
  const status = await tryGit(copy.path, ['status', '--porcelain']);
  const commits = await tryGit(copy.path, ['rev-list', '--count', `${copy.base}..HEAD`]);
  return status === '' && commits === '0';
}

/** Typed into the copy's session when its branch and the base branch conflict. */
export function resolvePrompt(copy: SessionCopy): string {
  return `Merge ${copy.base} into ${copy.branch} here and resolve the conflicts, keeping the intent of both sides. Then run the tests and commit the merge.`;
}

/** Ends the copy: deletes its folder and its branch, with whatever is in them. */
export async function removeCopy(projectPath: string, copy: SessionCopy) {
  await tryGit(projectPath, ['worktree', 'unlock', copy.path]);
  if (existsSync(copy.path)) await git(projectPath, ['worktree', 'remove', '--force', copy.path]);
  await tryGit(projectPath, ['worktree', 'prune']);
  await tryGit(projectPath, ['branch', '-D', copy.branch]);
}

/** Told to Claude at launch, so it stays in its copy and leaves merging to the user. */
export function copyInstructions(copy: SessionCopy): string {
  return [
    `You work in your own git worktree at ${copy.path} on branch ${copy.branch}, a separate checkout of the project made from ${copy.base}.`,
    'Other sessions may be editing the main checkout at the same time, so read and edit files only inside this worktree.',
    'It is a fresh checkout: install dependencies before you build, run or test anything.',
    `You may commit on ${copy.branch}. Do not merge into ${copy.base} or push: the user reviews and merges this copy from Orchia.`,
  ].join(' ');
}

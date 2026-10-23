import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseGitHubSource } from './githubSource.ts';
import { isDirectory, type Project } from './projects.ts';

/**
 * Opening a project from a GitHub URL: the repository is cloned next to the user's
 * other projects, or the clone already there is reused.
 */

export interface CloneTarget {
  /** "owner/name". */
  repo: string;
  path: string;
  /** A clone of this repository is already at `path`: it is opened, not cloned again. */
  existing: boolean;
}

/** A GitHub repository URL or `owner/repo`, else null. Branch and file URLs open their repository. */
export function parseRepo(text: string): { owner: string; name: string } | null {
  if (/\s/.test(text.trim())) return null; // `npx skills add …` lines are for the skills panel
  const source = parseGitHubSource(text);
  return source && { owner: source.owner, name: source.repo };
}

/** The folder most projects sit in, so clones land beside them. */
function cloneRoot(projects: Project[]): string {
  const count = new Map<string, number>();
  for (const p of projects) {
    const parent = dirname(p.path);
    if (parent !== p.path && isDirectory(parent)) count.set(parent, (count.get(parent) ?? 0) + 1);
  }
  const [best] = [...count].sort((a, b) => b[1] - a[1]);
  return best?.[0] ?? join(homedir(), 'projects');
}

function run(cmd: string, args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' } },
      (err, stdout, stderr) => {
        signal?.removeEventListener('abort', stop);
        if (!err) return resolve(stdout);
        const e = new Error(stderr.trim() || err.message) as Error & { code?: unknown };
        e.code = (err as NodeJS.ErrnoException).code;
        reject(e);
      },
    );
    // gh runs git, which Windows leaves running when only gh is killed: end the whole tree.
    function stop() {
      if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => {});
      else child.kill();
    }
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
  });
}

/** Whether the folder is a clone of owner/name. */
async function holds(path: string, owner: string, name: string): Promise<boolean> {
  const url = await run('git', ['remote', 'get-url', 'origin'], path).then((u) => u.trim(), () => '');
  const repo = parseRepo(url);
  return !!repo && repo.owner.toLowerCase() === owner.toLowerCase() && repo.name.toLowerCase() === name.toLowerCase();
}

/** Where the repository goes: its clone if one is already there, else the first free folder name. */
export async function cloneTarget(text: string, projects: Project[]): Promise<CloneTarget> {
  const repo = parseRepo(text);
  if (!repo) throw new Error('Not a GitHub repository URL');
  const root = cloneRoot(projects);
  for (let i = 1; ; i++) {
    const path = join(root, i === 1 ? repo.name : `${repo.name}-${i}`);
    if (!existsSync(path)) return { repo: `${repo.owner}/${repo.name}`, path, existing: false };
    // The folder's own spelling: a case-insensitive file system matches hello-world to Hello-World.
    if (await holds(path, repo.owner, repo.name)) return { repo: `${repo.owner}/${repo.name}`, path: realpathSync.native(path), existing: true };
  }
}

/** What to tell the user when the clone fails. */
function why(err: Error & { code?: unknown }): string {
  const text = err.message;
  if (/could not resolve to a repository|repository not found/i.test(text)) return 'Repository not found, or your GitHub login cannot see it.';
  if (/gh auth login|authentication|could not read username|permission denied/i.test(text)) return 'GitHub refused the clone: run gh auth login in a terminal, then try again.';
  return text.split('\n').filter(Boolean).pop() || 'The clone failed.';
}

/**
 * Clones through gh, so private repositories use the user's GitHub login, else plain git.
 * Returns the folder; a stopped or failed clone leaves nothing behind.
 */
export async function cloneRepo(text: string, projects: Project[], signal?: AbortSignal): Promise<string> {
  const target = await cloneTarget(text, projects);
  if (target.existing) return target.path;
  const parent = dirname(target.path);
  mkdirSync(parent, { recursive: true });
  try {
    try {
      await run('gh', ['repo', 'clone', target.repo, target.path], parent, signal);
    } catch (err) {
      if ((err as { code?: unknown }).code !== 'ENOENT') throw err;
      await run('git', ['clone', `https://github.com/${target.repo}.git`, target.path], parent, signal);
    }
  } catch (err) {
    rmSync(target.path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    if (signal?.aborted) throw new Error('Clone stopped');
    if ((err as { code?: unknown }).code === 'ENOENT') throw new Error('Install git to clone repositories.');
    throw new Error(why(err as Error));
  }
  return target.path;
}

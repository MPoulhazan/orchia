import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** An open issue of the project's GitHub repository, as the issue picker shows it. */
export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  author: string;
  /**
   * Opened by the owner, a member or a collaborator. Anyone else's text can try to steer
   * Claude, so the picker hides those issues until asked.
   */
  team: boolean;
  comments: number;
  url: string;
  updatedAt: string;
}

/**
 * `repo`: "owner/name". `dir`: the subfolder holding the repository when the project
 * folder is not one itself (a folder that groups a site and its assets, say).
 */
export type IssuesResult = { issues: GitHubIssue[]; repo: string; dir: string | null } | { unavailable: string };

const TEAM = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const MAX_BODY = 4000;

function gh(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      args,
      { cwd, timeout: 20_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const e = new Error(stderr.trim() || err.message) as Error & { code?: unknown };
        e.code = (err as NodeJS.ErrnoException).code;
        reject(e);
      },
    );
  });
}

/** What to tell the user when gh fails. */
function why(err: Error & { code?: unknown }): string {
  const text = err.message;
  if (err.code === 'ENOENT') return 'Install the GitHub CLI (gh) and run gh auth login to see this project’s issues.';
  if (/gh auth login|not logged|authentication/i.test(text)) return 'Run gh auth login in a terminal to see this project’s issues.';
  if (/none of the git remotes|no git remotes|could not determine/i.test(text)) return 'This project has no GitHub remote.';
  if (/disabled issues|has issues disabled/i.test(text)) return 'Issues are turned off for this repository.';
  if (/must have admin|not have permission|resource not accessible/i.test(text)) return 'Only an admin of the repository can delete its issues.';
  return text.split('\n')[0] || 'GitHub did not answer.';
}

class Unavailable extends Error {}

/** The GitHub repository of the folder, else of its only subfolder that is a git repository. */
async function findRepo(cwd: string): Promise<{ repo: string; dir: string | null }> {
  const nameOf = async (dir: string) => (await gh(dir, ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'])).trim();
  try {
    return { repo: await nameOf(cwd), dir: null };
  } catch (err) {
    if (!/not a git repository/i.test((err as Error).message)) throw new Unavailable(why(err as Error));
  }
  let dirs: string[] = [];
  try {
    dirs = readdirSync(cwd, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && existsSync(join(cwd, d.name, '.git')))
      .map((d) => d.name);
  } catch {}
  if (!dirs.length) throw new Unavailable('This project is not a git repository.');
  if (dirs.length > 1) throw new Unavailable(`This folder holds several repositories (${dirs.join(', ')}): open the one you want as a project.`);
  try {
    return { repo: await nameOf(join(cwd, dirs[0])), dir: dirs[0] };
  } catch (err) {
    throw new Unavailable(why(err as Error));
  }
}

/** The repository's open issues (not pull requests), most recently updated first, through the user's gh login. */
export async function openIssues(cwd: string): Promise<IssuesResult> {
  let raw: string;
  let found: { repo: string; dir: string | null };
  try {
    found = await findRepo(cwd);
    raw = await gh(cwd, ['api', `repos/${found.repo}/issues?state=open&sort=updated&per_page=60`]);
  } catch (err) {
    return { unavailable: err instanceof Unavailable ? err.message : why(err as Error) };
  }
  const list = JSON.parse(raw) as any[];
  const issues = list
    .filter((i) => !i.pull_request)
    .map((i) => ({
      number: i.number,
      title: String(i.title ?? ''),
      body: String(i.body ?? '').slice(0, MAX_BODY),
      labels: (i.labels ?? []).map((l: any) => (typeof l === 'string' ? l : l.name)).filter(Boolean),
      author: i.user?.login ?? '',
      team: TEAM.has(i.author_association),
      comments: i.comments ?? 0,
      url: i.html_url ?? '',
      updatedAt: i.updated_at ?? '',
    }));
  return { issues, ...found };
}

/** Closes an issue as not planned, or deletes it for good (repository admins only). */
export async function dropIssue(cwd: string, n: number, how: 'close' | 'delete'): Promise<string | null> {
  try {
    const { repo } = await findRepo(cwd);
    const args = how === 'close' ? ['issue', 'close', String(n), '-R', repo, '--reason', 'not planned'] : ['issue', 'delete', String(n), '-R', repo, '--yes'];
    await gh(cwd, args);
    return null;
  } catch (err) {
    return err instanceof Unavailable ? err.message : why(err as Error);
  }
}

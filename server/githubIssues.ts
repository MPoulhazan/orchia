import { execFile } from 'node:child_process';

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

export type IssuesResult = { issues: GitHubIssue[] } | { unavailable: string };

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

/** What to tell the user when gh can't list the issues. */
function why(err: Error & { code?: unknown }): string {
  const text = err.message;
  if (err.code === 'ENOENT') return 'Install the GitHub CLI (gh) and run gh auth login to see this project’s issues.';
  if (/gh auth login|not logged|authentication/i.test(text)) return 'Run gh auth login in a terminal to see this project’s issues.';
  if (/none of the git remotes|not a git repository|no git remotes|could not determine/i.test(text)) return 'This project has no GitHub remote.';
  if (/disabled issues|has issues disabled/i.test(text)) return 'Issues are turned off for this repository.';
  return text.split('\n')[0] || 'GitHub did not answer.';
}

/** The repository's open issues (not pull requests), most recently updated first, through the user's gh login. */
export async function openIssues(cwd: string): Promise<IssuesResult> {
  let raw: string;
  try {
    // {owner}/{repo} is filled in by gh from the folder's git remote.
    raw = await gh(cwd, ['api', 'repos/{owner}/{repo}/issues?state=open&sort=updated&per_page=60']);
  } catch (err) {
    return { unavailable: why(err as Error) };
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
  return { issues };
}

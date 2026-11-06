import { execFile } from 'node:child_process';
import { openIssues, type GitHubIssue } from './githubIssues.ts';
import { issuePrompt, queuedIssue } from './issuePrompt.ts';

/**
 * Issue → Up next: an open issue labelled `orchia:go` (fix it) or `orchia:plan` (plan it as lots
 * first) goes into the Up next of its project's newest running session, with the same prompt as
 * the issue picker. The label is the go-ahead, so it works from GitHub on a phone too, and it
 * also covers issues opened by people outside the project: whoever can label has read it.
 * Orchia then removes the label, so another computer with the same project does not take it again
 * and labelling it later queues it once more. Read with the user's gh login, nothing else.
 */

export const GO_LABEL = 'orchia:go';
export const PLAN_LABEL = 'orchia:plan';
const CHECK_EVERY_MS = 2 * 60 * 1000;

export interface LabelSession {
  id: string;
  projectId: string;
  cwd: string;
  /** The texts already in its Up next, to never queue an issue twice. */
  queued: string[];
}

export interface IssueLabelDeps {
  sessions: () => LabelSession[];
  enqueue: (sessionId: string, text: string) => void;
  /** `gh` for the issues of a folder; the repo and the subfolder holding it come with them. */
  issues?: (cwd: string) => Promise<{ issues: GitHubIssue[]; repo: string; dir: string | null } | null>;
  /** Removes the labels; false when GitHub refused (no write access, say). */
  unlabel?: (cwd: string, repo: string, n: number, labels: string[]) => Promise<boolean>;
}

/** The labelled issues to queue, oldest number first, with whether to plan first. */
export function issuesToQueue(issues: GitHubIssue[], queued: string[]): { issue: GitHubIssue; planFirst: boolean; labels: string[] }[] {
  const inQueue = new Set(queued.map((t) => queuedIssue(t)?.number).filter((n): n is number => n !== undefined));
  return issues
    .filter((i) => (i.labels.includes(GO_LABEL) || i.labels.includes(PLAN_LABEL)) && !inQueue.has(i.number))
    .sort((a, b) => a.number - b.number)
    .map((issue) => ({
      issue,
      planFirst: issue.labels.includes(PLAN_LABEL),
      labels: [GO_LABEL, PLAN_LABEL].filter((l) => issue.labels.includes(l)),
    }));
}

async function ghIssues(cwd: string) {
  const r = await openIssues(cwd);
  return 'issues' in r ? r : null;
}

function ghUnlabel(cwd: string, repo: string, n: number, labels: string[]): Promise<boolean> {
  const args = ['issue', 'edit', String(n), '-R', repo, ...labels.flatMap((l) => ['--remove-label', l])];
  return new Promise((resolve) =>
    execFile('gh', args, { cwd, timeout: 20_000, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }, (err) => resolve(!err)),
  );
}

export class IssueLabelWatcher {
  private readonly checkedAt = new Map<string, number>();
  /** Queued but still labelled (GitHub refused to remove it): `owner/repo#12`, not queued again. */
  private readonly kept = new Set<string>();
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly issues;
  private readonly unlabel;

  constructor(private readonly deps: IssueLabelDeps) {
    this.issues = deps.issues ?? ghIssues;
    this.unlabel = deps.unlabel ?? ghUnlabel;
  }

  start(everyMs = 15_000) {
    this.timer ??= setInterval(() => void this.tick(), everyMs);
    this.timer.unref?.();
    void this.tick();
  }

  /** Queues what is newly labelled in each project; returns how many prompts went to Up next. */
  async tick(now = Date.now()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let count = 0;
    try {
      for (const s of this.deps.sessions()) {
        if (now - (this.checkedAt.get(s.cwd) ?? 0) < CHECK_EVERY_MS) continue;
        this.checkedAt.set(s.cwd, now);
        const found = await this.issues(s.cwd).catch(() => null);
        if (!found) continue;
        for (const { issue, planFirst, labels } of issuesToQueue(found.issues, s.queued)) {
          const key = `${found.repo}#${issue.number}`;
          if (this.kept.has(key)) continue;
          this.deps.enqueue(s.id, issuePrompt(issue, planFirst, found.repo, found.dir));
          count++;
          if (!(await this.unlabel(s.cwd, found.repo, issue.number, labels))) this.kept.add(key);
        }
      }
    } finally {
      this.running = false;
    }
    return count;
  }
}

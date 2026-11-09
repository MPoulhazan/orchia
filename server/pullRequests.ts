import { execFile } from 'node:child_process';

/**
 * What happened to a session's pull request after the push: CI failed, a reviewer asked for
 * changes, or it was merged. Read with the user's gh login (`gh pr view` on the session's
 * branch), so it needs no GitHub App and nothing goes through Orchia Cloud. A card in Needs you
 * can then hand a failure back to Claude in the right session.
 */

export type PullRequestKind = 'ci-failed' | 'changes-requested' | 'merged';

export interface PullRequestNeed {
  /** Changes with each commit for CI and reviews, so a new failure shows again after "Later". */
  key: string;
  sessionId: string;
  projectId: string;
  kind: PullRequestKind;
  number: number;
  title: string;
  url: string;
  /** The checks that failed, for `ci-failed`. */
  failed: string[];
  /** Checks still running, for `ci-failed`: the list may grow. */
  pending: number;
}

export interface PullRequestState {
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  headSha: string;
  mergedAt: string | null;
  reviewDecision: string | null;
  failed: string[];
  pending: number;
}

/** Conclusions that mean a check failed (a skipped or neutral check did not). */
const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);
const MAX_TITLE = 200;
/** A merge is news for a day, then the card goes on its own. */
const MERGED_FOR_MS = 24 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 2 * 60 * 1000;
/** Sooner while checks are still running: the result is what the user waits for. */
const CHECK_PENDING_EVERY_MS = 45 * 1000;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** `gh pr view --json …` output, cut to what Orchia uses. Null when it is not a pull request. */
export function parsePullRequest(raw: any): PullRequestState | null {
  if (!raw || typeof raw.number !== 'number' || typeof raw.url !== 'string') return null;
  const failed: string[] = [];
  let pending = 0;
  for (const c of Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup : []) {
    // A CheckRun has status and conclusion; a commit status (StatusContext) has state.
    const name = String(c?.name ?? c?.context ?? 'check');
    const result = String(c?.conclusion ?? c?.state ?? '').toUpperCase();
    const running = c?.__typename === 'StatusContext' ? result === 'PENDING' || result === 'EXPECTED' : String(c?.status ?? '').toUpperCase() !== 'COMPLETED';
    if (running) pending++;
    else if (FAILED.has(result) && !failed.includes(name)) failed.push(clip(name, 80));
  }
  const state = raw.state === 'MERGED' || raw.state === 'CLOSED' ? raw.state : 'OPEN';
  return {
    number: raw.number,
    title: clip(String(raw.title ?? ''), MAX_TITLE),
    url: raw.url,
    state,
    headSha: String(raw.headRefOid ?? ''),
    mergedAt: typeof raw.mergedAt === 'string' && raw.mergedAt ? raw.mergedAt : null,
    reviewDecision: typeof raw.reviewDecision === 'string' && raw.reviewDecision ? raw.reviewDecision : null,
    failed,
    pending,
  };
}

/** What the pull request needs from the user right now, most urgent first. */
export function needsOf(pr: PullRequestState, now = Date.now()): { kind: PullRequestKind; key: string }[] {
  const sha = pr.headSha.slice(0, 12);
  if (pr.state === 'MERGED') {
    const at = pr.mergedAt ? Date.parse(pr.mergedAt) : NaN;
    return Number.isFinite(at) && now - at < MERGED_FOR_MS ? [{ kind: 'merged', key: `pr:${pr.url}:merged` }] : [];
  }
  if (pr.state !== 'OPEN') return [];
  const needs: { kind: PullRequestKind; key: string }[] = [];
  if (pr.failed.length) needs.push({ kind: 'ci-failed', key: `pr:${pr.url}:ci-failed:${sha}` });
  if (pr.reviewDecision === 'CHANGES_REQUESTED') needs.push({ kind: 'changes-requested', key: `pr:${pr.url}:changes-requested:${sha}` });
  return needs;
}

/**
 * The one-line prompt "Send to Claude" puts in Up next. Claude reads the failure or the review
 * itself with gh: the text of the logs and of the review never goes through Orchia.
 */
export function promptFor(need: PullRequestNeed): string | null {
  const n = need.number;
  if (need.kind === 'ci-failed') {
    const which = need.failed.length ? ` (${need.failed.slice(0, 5).join(', ')})` : '';
    return `CI failed on PR #${n}${which}. Read the failure with gh pr checks ${n} and gh run view <run id> --log-failed, fix the cause, run the tests locally, then commit and push.`;
  }
  if (need.kind === 'changes-requested') {
    return `A reviewer asked for changes on PR #${n}. Read the review with gh pr view ${n} --comments, address each point, then commit and push.`;
  }
  return null;
}

function ghPrView(cwd: string): Promise<any | null> {
  return new Promise((resolve) => {
    execFile(
      'gh',
      ['pr', 'view', '--json', 'number,title,url,state,headRefOid,mergedAt,reviewDecision,statusCheckRollup'],
      { cwd, timeout: 20_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } },
      // No gh, not signed in, no remote, no pull request for this branch: nothing to say.
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve(null);
        }
      },
    );
  });
}

interface Watched {
  checkedAt: number;
  pr: PullRequestState | null;
  checking: boolean;
}

/** Keeps the pull request of each running session's folder fresh, one gh call at a time. */
export class PullRequestWatcher {
  private readonly byCwd = new Map<string, Watched>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sessions: () => { id: string; projectId: string; cwd: string }[],
    private readonly onChange: () => void,
    private readonly fetch: (cwd: string) => Promise<any | null> = ghPrView,
  ) {}

  start(everyMs = 15_000) {
    this.timer ??= setInterval(() => void this.tick(), everyMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = Date.now()) {
    const cwds = new Set(this.sessions().map((s) => s.cwd));
    let changed = false;
    for (const cwd of this.byCwd.keys()) {
      if (!cwds.has(cwd)) {
        changed ||= !!this.byCwd.get(cwd)?.pr;
        this.byCwd.delete(cwd);
      }
    }
    for (const cwd of cwds) {
      const w = this.byCwd.get(cwd) ?? { checkedAt: 0, pr: null, checking: false };
      this.byCwd.set(cwd, w);
      const every = w.pr?.pending ? CHECK_PENDING_EVERY_MS : CHECK_EVERY_MS;
      if (w.checking || now - w.checkedAt < every) continue;
      w.checking = true;
      try {
        const pr = parsePullRequest(await this.fetch(cwd));
        changed ||= JSON.stringify(pr) !== JSON.stringify(w.pr);
        w.pr = pr;
      } finally {
        w.checking = false;
        w.checkedAt = now;
      }
    }
    if (changed) this.onChange();
  }

  /** The pull request of a watched folder's branch, as last read. */
  pullRequestOf(cwd: string): PullRequestState | null {
    return this.byCwd.get(cwd)?.pr ?? null;
  }

  /** Every card, for the session given for the folder. */
  needs(now = Date.now()): PullRequestNeed[] {
    return this.sessions().flatMap((s) => {
      const pr = this.byCwd.get(s.cwd)?.pr;
      if (!pr) return [];
      return needsOf(pr, now).map(({ kind, key }) => ({
        key,
        sessionId: s.id,
        projectId: s.projectId,
        kind,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        failed: kind === 'ci-failed' ? pr.failed : [],
        pending: kind === 'ci-failed' ? pr.pending : 0,
      }));
    });
  }
}

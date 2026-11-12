import type { SessionInfo, TurnCheck } from './api';

export type Status = 'starting' | 'working' | 'stuck' | 'waiting' | 'blocked' | 'done' | 'idle' | 'paused' | 'exited';

/**
 * Where a session stands. A finished turn is not just "done": it may have ended
 * on an error (blocked) or on a question for the user (waiting). Both read as
 * such until the user looks; a failed turn keeps its red dot after that.
 */
export function statusOf(s: SessionInfo): Status {
  if (s.status === 'exited') return 'exited';
  if (s.status === 'suspended') return 'paused';
  if (s.activity === 'waiting') return 'waiting';
  if (s.activity === 'working') return s.stuck ? 'stuck' : 'working';
  if (s.activity === 'idle') {
    if (s.summary?.failed && !s.stoppedByUser) return 'blocked';
    if (!s.unseen) return 'idle';
    return s.summary?.question && !s.stoppedByUser ? 'waiting' : 'done';
  }
  return 'starting';
}

/** Why a session waits on the user: the permission or question from the hook, or the one its reply ends on. */
export function waitingText(s: SessionInfo): string {
  return s.detail ?? s.summary?.question ?? 'Needs your input';
}

export const statusLabel: Record<Status, string> = {
  starting: 'Ready',
  working: 'Working',
  stuck: 'Stuck?',
  waiting: 'Needs you',
  blocked: 'Blocked',
  done: 'Done',
  idle: 'Idle',
  paused: 'Paused',
  exited: 'Ended',
};

/** Sessions that want the user's attention: waiting on them, going in circles, or finished and not looked at yet. */
export function needsAttention(s: SessionInfo): boolean {
  const status = statusOf(s);
  return status === 'waiting' || status === 'stuck' || status === 'done' || (status === 'blocked' && s.unseen);
}

/** Most urgent first: Needs you, Blocked, Stuck?, Done. */
export const attentionRank: Partial<Record<Status, number>> = { waiting: 0, blocked: 1, stuck: 2, done: 3 };

const CHECK_LABEL: Record<TurnCheck['kind'], string> = { tests: 'tests', types: 'types', lint: 'lint', build: 'build', push: 'pushed' };

/**
 * What the turn proved: "✓ tests ✓ types · pushed", "✗ build", or "not tested"
 * when it changed files without running any check. Null when there is nothing to say.
 */
export function proofText(summary: SessionInfo['summary']): string | null {
  if (!summary) return null;
  const checks = summary.checks ?? [];
  const runs = checks.filter((c) => c.kind !== 'push').map((c) => `${c.ok ? '✓' : '✗'} ${CHECK_LABEL[c.kind]}`);
  const push = checks.find((c) => c.kind === 'push');
  if (push) runs.push(push.ok ? 'pushed' : '✗ push');
  if (!runs.length) return summary.files && !summary.failed ? 'not tested' : null;
  return runs.join(' ');
}

/** "✓ tests ✓ types", in green, or red with the failing check. */
export function Proof({ summary }: { summary: SessionInfo['summary'] }) {
  const text = proofText(summary);
  if (!text) return null;
  const failed = summary?.checks?.some((c) => !c.ok);
  const tone = failed ? 'bad' : text === 'not tested' ? 'none' : 'ok';
  return (
    <span className="proof" data-tone={tone} title={tone === 'none' ? 'Files changed, but no tests, type check or build ran in this turn.' : 'Checks run during this turn; the last run of each counts.'}>
      {text}
    </span>
  );
}

export function StatusDot({ session }: { session: SessionInfo }) {
  const status = statusOf(session);
  return <span className="status-dot" data-status={status} title={session.detail ?? statusLabel[status]} />;
}

/** "3 files changed", or null when the turn changed none. */
export function filesChanged(n: number): string | null {
  return n ? `${n} file${n > 1 ? 's' : ''} changed` : null;
}

/** "Pins cluster above 40 markers. · 3 files changed": what the last turn did. */
export function DoneSummary({ session }: { session: SessionInfo }) {
  const summary = session.summary;
  if (!summary) return null;
  const files = filesChanged(summary.files);
  return (
    <>
      {summary.text}
      {files && <span className="done-meta"> · {files}</span>}
      {proofText(summary) && (
        <>
          {' '}
          <Proof summary={summary} />
        </>
      )}
    </>
  );
}

/** Two letters for the rail: "Scraper fix" → SF, "Session 1" → S1, "orchia" → OR. */
export function initials(name: string): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}

/** "just now", "4 minutes ago", "yesterday", "3 days ago", "last week"… */
export function timeAgo(time: number, now = Date.now()): string {
  const minutes = Math.round((now - time) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

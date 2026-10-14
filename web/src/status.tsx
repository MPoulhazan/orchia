import type { SessionInfo } from './api';

export type Status = 'starting' | 'working' | 'waiting' | 'done' | 'idle' | 'paused' | 'exited';

export function statusOf(s: SessionInfo): Status {
  if (s.status === 'exited') return 'exited';
  if (s.status === 'suspended') return 'paused';
  if (s.activity === 'waiting') return 'waiting';
  if (s.activity === 'working') return 'working';
  if (s.activity === 'idle') return s.unseen ? 'done' : 'idle';
  return 'starting';
}

export const statusLabel: Record<Status, string> = {
  starting: 'Ready',
  working: 'Working',
  waiting: 'Needs you',
  done: 'Done',
  idle: 'Idle',
  paused: 'Paused',
  exited: 'Ended',
};

/** Sessions that want the user's attention: blocked on them, or finished and not looked at yet. */
export function needsAttention(s: SessionInfo): boolean {
  const status = statusOf(s);
  return status === 'waiting' || status === 'done';
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

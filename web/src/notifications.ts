import { useEffect, useRef, useState } from 'react';
import type { Project, SessionInfo } from './api';
import { filesChanged, proofText, statusOf, waitingText, type Status } from './status';

/** "Pins cluster above 40 markers. (3 files changed)"; at the end of a run of lots, how it went. */
function doneText(s: SessionInfo): string {
  const run = s.lotRun;
  if (run?.state === 'done') return `All ${run.total} lots done`;
  if (run?.state === 'blocked') {
    const reason = s.lotBlocked?.reason;
    return `Lot ${run.n}/${run.total} ${reason ? `blocked: ${reason}` : 'ended without saying it was done'}`;
  }
  if (!s.summary) return 'Finished';
  const files = filesChanged(s.summary.files);
  const proof = proofText(s.summary);
  const text = files ? `${s.summary.text} (${files})` : s.summary.text;
  return proof ? `${proof} · ${text}` : text;
}
import { storage } from './storage';

export type NotifyState = 'on' | 'off' | 'blocked';

const KEY = 'orchia.notifications';
const supported = typeof window !== 'undefined' && 'Notification' in window;

/** True when the user is actually looking at this tab. */
export function pageActive(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

/**
 * Desktop notifications when a session starts waiting on the user or finishes,
 * only while the tab is not in front. Clicking one brings the session up.
 */
export function useNotifications(sessions: SessionInfo[], projects: Project[], onOpen: (id: string) => void) {
  const [enabled, setEnabled] = useState(() => storage.get(KEY) === 'on');
  const [permission, setPermission] = useState<NotificationPermission>(supported ? Notification.permission : 'denied');
  const previous = useRef(new Map<string, Status>());
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  const state: NotifyState = permission === 'denied' ? 'blocked' : enabled && permission === 'granted' ? 'on' : 'off';

  async function toggle() {
    if (!supported || permission === 'denied') return;
    if (state === 'on') {
      setEnabled(false);
      storage.set(KEY, 'off');
      return;
    }
    const result = permission === 'granted' ? permission : await Notification.requestPermission();
    setPermission(result);
    if (result === 'granted') {
      setEnabled(true);
      storage.set(KEY, 'on');
    }
  }

  useEffect(() => {
    const next = new Map<string, Status>();
    for (const s of sessions) {
      const status = statusOf(s);
      const before = previous.current.get(s.id);
      next.set(s.id, status);
      // `before` is unknown on first load, so reopening the page does not replay old events.
      if (state !== 'on' || !before || before === status || pageActive()) continue;
      if (status !== 'waiting' && status !== 'done' && status !== 'blocked' && status !== 'stuck') continue;
      // A lot that ended well with more to come: one notification for the whole plan, at its end.
      if (status === 'done' && s.lotRun?.state === 'running') continue;

      const project = projects.find((p) => p.id === s.projectId)?.name ?? '';
      // The verdict leads the title, so the notification alone says whether to come back.
      const verdict = { waiting: 'Needs you', blocked: 'Blocked', stuck: 'Stuck?', done: 'Done' }[status];
      const body =
        status === 'waiting' ? waitingText(s)
        : status === 'stuck' ? (s.stuck ?? 'Going in circles')
        : status === 'blocked' ? (s.detail ?? 'Stopped on an error')
        : s.lotRun ? doneText(s)
        : (s.detail ?? doneText(s));
      const notification = new Notification(`${verdict}: ${project} / ${s.name}`, {
        body,
        tag: s.id,
      });
      notification.onclick = () => {
        window.focus();
        openRef.current(s.id);
        notification.close();
      };
    }
    previous.current = next;
  }, [sessions, state]);

  return { state, toggle };
}

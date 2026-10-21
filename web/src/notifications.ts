import { useEffect, useRef, useState } from 'react';
import type { Project, SessionInfo } from './api';
import { filesChanged, statusOf, type Status } from './status';

/** "Pins cluster above 40 markers. (3 files changed)" */
function doneText(s: SessionInfo): string {
  if (!s.summary) return 'Finished';
  const files = filesChanged(s.summary.files);
  return files ? `${s.summary.text} (${files})` : s.summary.text;
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
      if (status !== 'waiting' && status !== 'done') continue;

      const project = projects.find((p) => p.id === s.projectId)?.name ?? '';
      const notification = new Notification(`${project} / ${s.name}`, {
        body: status === 'waiting' ? (s.detail ?? 'Needs your input') : (s.detail ?? doneText(s)),
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

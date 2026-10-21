import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Gauge, X } from 'lucide-react';
import type { LimitWindow, RateLimits } from './api';
import type { NotifyState } from './notifications';
import { pageActive } from './notifications';
import { storage } from './storage';

/**
 * The plan's usage limits, as Claude Code reports them to its status line:
 * a rolling 5-hour window and a weekly one, shared by every session.
 * Shown as two meters in the sidebar (or rail), an alert when a threshold is
 * crossed, and a banner while a limit is reached.
 */

type WindowKey = keyof RateLimits;
export type LimitLevel = 'ok' | 'warn' | 'high' | 'full';

const WINDOWS: { key: WindowKey; label: string; short: string }[] = [
  { key: 'fiveHour', label: '5-hour limit', short: '5h' },
  { key: 'sevenDay', label: 'Weekly limit', short: '7d' },
];

/** Alerts fire once per window when usage crosses these. */
const ALERT_AT = [80, 95, 100];
const ALERTS_KEY = 'orchia.limitAlerts';
const TOAST_MS = 12_000;

export function levelOf(pct: number): LimitLevel {
  return pct >= 100 ? 'full' : pct >= 90 ? 'high' : pct >= 70 ? 'warn' : 'ok';
}

/** A window whose reset time has passed starts over, even before a session reports again. */
function current(win: LimitWindow | null, now: number): LimitWindow | null {
  if (!win) return null;
  return win.resetsAt !== null && win.resetsAt <= now ? { usedPct: 0, resetsAt: null } : win;
}

/** Re-renders on a timer so countdowns and expired windows stay right. */
function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

// The UI is in English; 24-hour clock.
const LOCALE = 'en-GB';

function clock(t: number): string {
  return new Date(t).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
}

/** "in 1 h 47 min", "in 3 days" */
function countdown(t: number, now: number): string {
  const min = Math.max(1, Math.round((t - now) / 60_000));
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `in ${h} h${min % 60 ? ` ${String(min % 60).padStart(2, '0')}` : ''}`;
  const days = Math.round(h / 24);
  return `in ${days} day${days > 1 ? 's' : ''}`;
}

/** "at 14:30 (in 1 h 47)" within a day, "Thu 14:30 (in 3 days)" further out. */
export function resetText(t: number | null, now: number): string {
  if (t === null) return 'reset time unknown';
  const when =
    t - now < 86_400_000 ? `at ${clock(t)}` : `${new Date(t).toLocaleDateString(LOCALE, { weekday: 'short' })} ${clock(t)}`;
  return `${when} (${countdown(t, now)})`;
}

/** The highest usage across both windows, for the tab icon. */
export function topLevel(limits: RateLimits | null): LimitLevel {
  const now = Date.now();
  const pcts = WINDOWS.map(({ key }) => current(limits?.[key] ?? null, now)?.usedPct ?? 0);
  return levelOf(Math.max(0, ...pcts));
}

// ---- Meters --------------------------------------------------------------------

const FOLD_KEY = 'orchia.usageFolded';

/** Folded by the user, and the near-limit windows it was folded during (so they don't reopen it). */
interface Fold {
  collapsed: boolean;
  keepClosed: string | null;
}

function useFold(): [Fold, (next: Fold) => void] {
  const [fold, setFold] = useState<Fold>(() => {
    try {
      const saved = JSON.parse(storage.get(FOLD_KEY) ?? 'null');
      return { collapsed: !!saved?.collapsed, keepClosed: saved?.keepClosed ?? null };
    } catch {
      return { collapsed: false, keepClosed: null };
    }
  });
  const save = (next: Fold) => {
    setFold(next);
    storage.set(FOLD_KEY, JSON.stringify(next));
  };
  return [fold, save];
}

/** Two meters: full rows in the sidebar, stacked minis in the rail. Hidden when the plan reports no limits. */
export function UsageMeters({ limits, compact }: { limits: RateLimits | null; compact?: boolean }) {
  const now = useNow();
  const [fold, setFold] = useFold();
  if (!limits) return null;
  const rows = WINDOWS.map((w) => ({ ...w, win: current(limits[w.key], now) })).filter((r) => r.win);

  if (compact) {
    return (
      <div className="usage-mini">
        {rows.map(({ key, label, short, win }) => (
          <div
            key={key}
            className="usage-mini-item"
            data-level={levelOf(win!.usedPct)}
            title={`${label}: ${win!.usedPct}% used · resets ${resetText(win!.resetsAt, now)}`}
          >
            <span className="usage-mini-label">
              {short}
              <span>{win!.usedPct}</span>
            </span>
            <Bar pct={win!.usedPct} />
          </div>
        ))}
      </div>
    );
  }

  // Close to a limit, the meters open again, unless folded once more for these windows.
  const nearSig = rows
    .filter((r) => r.win!.usedPct >= 90)
    .map((r) => `${r.key}@${r.win!.resetsAt}`)
    .join(',');
  const open = !fold.collapsed || (nearSig !== '' && fold.keepClosed !== nearSig);
  const toggle = () => setFold(open ? { collapsed: true, keepClosed: nearSig || null } : { collapsed: false, keepClosed: null });

  return (
    <div className="usage" data-open={open}>
      <button className="usage-head" aria-expanded={open} onClick={toggle} title={open ? 'Collapse' : 'Expand'}>
        <Gauge size={12} />
        <span>Plan usage</span>
        {!open && (
          <span className="usage-sum">
            {rows.map(({ key, short, win }) => (
              <span key={key} data-level={levelOf(win!.usedPct)} title={`Resets ${resetText(win!.resetsAt, now)}`}>
                <i>{short}</i> {win!.usedPct}%
              </span>
            ))}
          </span>
        )}
        <ChevronRight size={13} className={`chevron ${open ? 'is-open' : ''}`} />
      </button>
      {open && rows.map(({ key, label, win }) => {
        const level = levelOf(win!.usedPct);
        return (
          <div key={key} className="usage-row" data-level={level} title={`Resets ${resetText(win!.resetsAt, now)}`}>
            <span className="usage-label">{label.replace(' limit', '')}</span>
            <Bar pct={win!.usedPct} />
            <span className="usage-pct">{win!.usedPct}%</span>
            {level !== 'ok' && win!.resetsAt !== null && (
              <span className="usage-reset">Resets {resetText(win!.resetsAt, now)}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Bar({ pct }: { pct: number }) {
  return (
    <span className="usage-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <span style={{ width: `${Math.min(100, Math.max(pct, 0))}%` }} />
    </span>
  );
}

// ---- Reached banner -------------------------------------------------------------

/** Above the sessions while a limit is reached: why Claude stopped, and when it can go on. */
export function LimitBanner({ limits }: { limits: RateLimits | null }) {
  const now = useNow(15_000);
  if (!limits) return null;
  const reached = WINDOWS.map((w) => ({ ...w, win: current(limits[w.key], now) })).filter(
    (r) => r.win && r.win.usedPct >= 100,
  );
  if (!reached.length) return null;
  // With both reached, the later reset is the one that matters.
  const until = Math.max(...reached.map((r) => r.win!.resetsAt ?? 0)) || null;
  const names = reached.map((r) => r.label).join(' and ');

  return (
    <div className="limit-banner" role="status">
      <Gauge size={15} />
      <b>{names} reached</b>
      <span>
        Sessions can't get replies until it resets {resetText(until, now)}.
      </span>
    </div>
  );
}

// ---- Threshold alerts -------------------------------------------------------------

interface Toast {
  id: number;
  key: WindowKey;
  level: LimitLevel;
  title: string;
  body: string;
}

/** The highest threshold already announced, per window, keyed by when that window resets. */
type Announced = Partial<Record<WindowKey, { resetsAt: number | null; at: number }>>;

function readAnnounced(): Announced {
  try {
    return JSON.parse(storage.get(ALERTS_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

/**
 * One alert each time a window crosses 80%, 95% or 100%, never twice for the same
 * window (remembered across reloads). An in-page toast, plus a desktop notification
 * when they are on and the tab is in the background.
 */
export function useLimitAlerts(limits: RateLimits | null, notify: NotifyState) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  useEffect(() => {
    if (!limits) return;
    const now = Date.now();
    const announced = readAnnounced();
    let changed = false;
    for (const { key, label } of WINDOWS) {
      const win = current(limits[key], now);
      if (!win) continue;
      const crossed = ALERT_AT.filter((t) => win.usedPct >= t).at(-1);
      const seen = announced[key];
      const sameWindow = seen && seen.resetsAt === win.resetsAt;
      if (crossed === undefined || (sameWindow && seen.at >= crossed)) continue;
      announced[key] = { resetsAt: win.resetsAt, at: crossed };
      changed = true;

      const title = crossed >= 100 ? `${label} reached` : `${label} at ${win.usedPct}%`;
      const body = `Resets ${resetText(win.resetsAt, now)}.`;
      const id = nextId.current++;
      // A newer alert for the same window replaces the older one.
      setToasts((list) => [...list.filter((t) => t.key !== key), { id, key, level: levelOf(win.usedPct), title, body }]);
      setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), TOAST_MS);
      if (notify === 'on' && !pageActive()) new Notification(title, { body, tag: `limit-${key}` });
    }
    if (changed) storage.set(ALERTS_KEY, JSON.stringify(announced));
  }, [limits, notify]);

  const dismiss = (id: number) => setToasts((list) => list.filter((t) => t.id !== id));
  return { toasts, dismiss };
}

export function LimitToasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast" data-level={t.level}>
          <Gauge size={15} className="toast-icon" />
          <span className="toast-text">
            <b>{t.title}</b>
            <span>{t.body}</span>
          </span>
          <button className="icon-btn" title="Dismiss" onClick={() => onDismiss(t.id)}>
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

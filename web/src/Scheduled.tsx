import { useEffect, useState, useSyncExternalStore } from 'react';
import { CalendarClock, ChevronRight, Clock, Plus, X } from 'lucide-react';
import { api, type Project, type ScheduledItem } from './api';
import { ProjectIcon } from './ProjectIcon';

/**
 * Scheduled: prompts kept for a date (server/schedule.ts). The sidebar line opens the list;
 * a due or missed one shows in Needs you; the sheet schedules a new one or changes one.
 * List and sheet open from anywhere (sidebar, Up next) through `openScheduled` / `openScheduleSheet`.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ---- Opening the list and the sheet from anywhere ---------------------------

export interface SheetDraft {
  /** Set to change an existing item. */
  id?: string;
  projectId?: string;
  text?: string;
  at?: number;
  /** From Up next: leaves the queue once scheduled. */
  fromQueue?: { sessionId: string; queuedId: string };
}

type Open = { list: boolean; sheet: SheetDraft | null };
let opened: Open = { list: false, sheet: null };
const listeners = new Set<() => void>();
function set(next: Partial<Open>) {
  opened = { ...opened, ...next };
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const openScheduled = () => set({ list: true });
export const openScheduleSheet = (draft: SheetDraft) => set({ sheet: draft });

// ---- Dates ------------------------------------------------------------------

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** `days` days from the day of `t`, at hh:mm local time (whatever daylight saving does in between). */
function dayAt(t: number, days: number, hours: number, minutes = 0): number {
  const d = new Date(t);
  d.setDate(d.getDate() + days);
  d.setHours(hours, minutes, 0, 0);
  return d.getTime();
}

// Day and month names in English, like the rest of the UI ("Today", "Tomorrow"); the time keeps the user's own 12 or 24-hour clock.
const DATE_LOCALE = 'en-GB';
const time = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const weekday = (t: number) => new Date(t).toLocaleDateString(DATE_LOCALE, { weekday: 'short' });
const shortDate = (t: number) => new Date(t).toLocaleDateString(DATE_LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });

/** "16:00", "Tomorrow 09:00", "Mon 09:00", "Fri 5 Dec 09:00"; past days the same way. */
export function whenLabel(at: number, now = Date.now()): string {
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY);
  if (days === 0) return time(at);
  if (days === 1) return `Tomorrow ${time(at)}`;
  if (days === -1) return `Yesterday ${time(at)}`;
  if (days > 1 && days < 7) return `${weekday(at)} ${time(at)}`;
  return `${shortDate(at)} ${time(at)}`;
}

/** The list's groups, soonest first: what is due now, then each day of the coming week, then later. */
function groupOf(item: ScheduledItem, now: number): string {
  if (item.state !== 'waiting') return 'Now';
  const days = Math.round((startOfDay(item.at) - startOfDay(now)) / DAY);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days < 7) return new Date(item.at).toLocaleDateString(DATE_LOCALE, { weekday: 'long', day: 'numeric', month: 'short' });
  return 'Later';
}

/** Quick picks for the sheet; "Monday" is next Monday (in a week when today is Monday). */
function quickPicks(now: number): { label: string; at: number }[] {
  const toMonday = ((8 - new Date(now).getDay()) % 7) || 7;
  return [
    { label: 'In 1 hour', at: now + HOUR },
    { label: 'Tomorrow 9:00', at: dayAt(now, 1, 9) },
    { label: 'Monday 9:00', at: dayAt(now, toMonday, 9) },
    { label: 'In 1 week', at: dayAt(now, 7, 9) },
  ];
}

/** For <input type="datetime-local">: local time, minutes. */
function toLocalInput(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** A clock that ticks each minute, so "Today" and "Tomorrow" stay right. */
function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60 * 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

// ---- Sidebar line -----------------------------------------------------------

/** "Scheduled · 3 · next Mon 09:00" under the projects; opens the list. */
export function ScheduledLine({ items }: { items: ScheduledItem[] }) {
  const now = useNow();
  const next = items.find((i) => i.state === 'waiting');
  return (
    <button className="usage-head security-line scheduled-line" onClick={openScheduled} title="Prompts kept for a date">
      <CalendarClock size={12} />
      <span>Scheduled</span>
      <span className="usage-sum">{items.length ? (next ? `${items.length} · next ${whenLabel(next.at, now)}` : `${items.length}`) : 'none'}</span>
      <ChevronRight size={13} className="chevron" />
    </button>
  );
}

// ---- Due card (Needs you, and the top of the list) --------------------------

/** A due or missed prompt: run it now, put it off, or skip it. Clicking the text opens it. */
export function ScheduledRow({ item, project, onOpenSession, narrow }: { item: ScheduledItem; project?: Project; onOpenSession: (id: string) => void; narrow?: boolean }) {
  const [busy, setBusy] = useState(false);
  const act = (call: () => Promise<unknown>) => {
    setBusy(true);
    call().catch(() => setBusy(false));
  };
  const now = Date.now();
  const missed = item.state === 'missed';
  return (
    <div className="attention-row scheduled-row">
      <button className="attention-open" onClick={() => openScheduleSheet({ id: item.id })}>
        <span className="attention-title">
          {missed ? (
            <span className="mark" data-tone="warn" title="It came due while Orchia was closed: Orchia never runs one late on its own">
              Missed
            </span>
          ) : (
            <span className="mark">Due</span>
          )}
          <b>{item.title}</b>
        </span>
        <span className="attention-detail">
          {project?.name ?? 'Unknown project'} · {whenLabel(item.at, now)}
        </span>
      </button>
      <span className="perm-acts" data-small>
        <button
          className="btn btn-primary"
          disabled={busy}
          title="Puts the prompt in Up next of the project's newest session, or of a new one"
          onClick={() =>
            act(async () => {
              const { sessionId } = await api.runScheduled(item.id);
              onOpenSession(sessionId);
            })
          }
        >
          Run now
        </button>
        {/* The sidebar is too narrow for four controls; the sheet has "In 1 hour". */}
        {!narrow && (
          <button className="btn btn-secondary" disabled={busy} onClick={() => act(() => api.updateScheduled(item.id, { at: now + HOUR }))}>
            In 1 h
          </button>
        )}
        <button className="btn btn-secondary" disabled={busy} onClick={() => act(() => api.updateScheduled(item.id, { at: dayAt(now, 1, 9) }))}>
          Tomorrow
        </button>
        <button className="icon-btn" disabled={busy} title="Skip: remove it without running it" onClick={() => act(() => api.skipScheduled(item.id))}>
          <X size={13} />
        </button>
      </span>
    </div>
  );
}

// ---- The list and the sheet, drawn once by the app --------------------------

export function ScheduledHost({ items, projects, onOpenSession }: { items: ScheduledItem[]; projects: Project[]; onOpenSession: (id: string) => void }) {
  const { list, sheet } = useSyncExternalStore(subscribe, () => opened);
  const openSession = (id: string) => {
    set({ list: false, sheet: null });
    onOpenSession(id);
  };
  return (
    <>
      {list && <ScheduledList items={items} projects={projects} onOpenSession={openSession} onClose={() => set({ list: false })} />}
      {sheet && <ScheduleSheet draft={sheet} items={items} projects={projects} onOpenSession={openSession} onClose={() => set({ sheet: null })} />}
    </>
  );
}

function useEscape(onClose: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, active]);
}

function ScheduledList({ items, projects, onOpenSession, onClose }: { items: ScheduledItem[]; projects: Project[]; onOpenSession: (id: string) => void; onClose: () => void }) {
  const now = useNow();
  const sheetOpen = useSyncExternalStore(subscribe, () => opened.sheet !== null);
  // The sheet on top takes Escape first.
  useEscape(onClose, !sheetOpen);
  const project = (id: string) => projects.find((p) => p.id === id);
  const groups = new Map<string, ScheduledItem[]>();
  for (const item of items) {
    const g = groupOf(item, now);
    groups.set(g, [...(groups.get(g) ?? []), item]);
  }
  // Due ones first, oldest first; the rest is already soonest first.
  const order = ['Now', ...[...groups.keys()].filter((g) => g !== 'Now')].filter((g) => groups.has(g));

  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings scheduled-panel" role="dialog" aria-label="Scheduled">
        <header className="settings-head">
          <h2>Scheduled</h2>
          <span className="pane-spacer" />
          <button className="btn btn-secondary" onClick={() => openScheduleSheet({})} disabled={!projects.length}>
            <Plus size={13} /> New
          </button>
          <button className="icon-btn" title="Close (Esc)" onClick={onClose}>
            <X size={15} />
          </button>
        </header>
        <div className="settings-body">
          {!items.length ? (
            <div className="scheduled-empty">
              <p>Nothing scheduled.</p>
              <p className="security-hint">
                Keep a prompt for a date: Orchia reminds you when it is due, and puts it in Up next when you say so. Agents often say “check this again on Monday”: schedule it here, or from the clock on an Up next prompt.
              </p>
            </div>
          ) : (
            order.map((g) => (
              <section key={g} className="security-section">
                <h3 className={g === 'Now' ? 'scheduled-now' : undefined}>
                  {g} <span className="section-count">{groups.get(g)!.length}</span>
                </h3>
                <div className="scheduled-group">
                  {groups.get(g)!.map((item) =>
                    item.state === 'waiting' ? (
                      <button key={item.id} className="scheduled-entry" onClick={() => openScheduleSheet({ id: item.id })} title={item.text}>
                        <span className="scheduled-time">{g === 'Later' ? shortDate(item.at) : time(item.at)}</span>
                        {project(item.projectId) ? <ProjectIcon project={project(item.projectId)!} size={18} /> : <span style={{ width: 18 }} />}
                        <span className="scheduled-what">
                          <b>{item.title}</b>
                          <small>{project(item.projectId)?.name ?? 'Unknown project'}</small>
                        </span>
                      </button>
                    ) : (
                      <ScheduledRow key={item.id} item={item} project={project(item.projectId)} onOpenSession={onOpenSession} />
                    ),
                  )}
                </div>
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function ScheduleSheet({
  draft,
  items,
  projects,
  onOpenSession,
  onClose,
}: {
  draft: SheetDraft;
  items: ScheduledItem[];
  projects: Project[];
  onOpenSession: (id: string) => void;
  onClose: () => void;
}) {
  useEscape(onClose);
  const existing = draft.id ? items.find((i) => i.id === draft.id) : undefined;
  const [now] = useState(Date.now);
  const picks = quickPicks(now);
  const [projectId, setProjectId] = useState(existing?.projectId ?? draft.projectId ?? projects[0]?.id ?? '');
  const [text, setText] = useState(existing?.text ?? draft.text ?? '');
  const [at, setAt] = useState<number | null>(existing?.at ?? draft.at ?? picks[1].at);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Gone while open (run or skipped elsewhere).
  if (draft.id && !existing) return null;

  const save = async () => {
    if (!text.trim()) return setError('Write the prompt to schedule');
    if (at === null) return setError('Pick a date');
    setBusy(true);
    setError(null);
    try {
      if (existing) await api.updateScheduled(existing.id, { text, at, title: text === existing.text ? existing.title : '' });
      else await api.addScheduled({ projectId, text, at });
      if (draft.fromQueue) await api.dequeue(draft.fromQueue.sessionId, draft.fromQueue.queuedId).catch(() => {});
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const fixedProject = !!existing || !!draft.fromQueue;
  const project = projects.find((p) => p.id === projectId);
  const past = at !== null && at <= Date.now();

  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings schedule-sheet" role="dialog" aria-label={existing ? 'Scheduled prompt' : 'Schedule a prompt'}>
        <header className="settings-head">
          <h2>{existing ? 'Scheduled prompt' : 'Schedule a prompt'}</h2>
          <button className="icon-btn" title="Close (Esc)" onClick={onClose}>
            <X size={15} />
          </button>
        </header>
        <div className="settings-body schedule-form">
          <label className="schedule-label" htmlFor="schedule-project">
            Project
          </label>
          {fixedProject || projects.length < 2 ? (
            <span className="schedule-project">
              {project && <ProjectIcon project={project} size={16} />} {project?.name ?? 'Unknown project'}
            </span>
          ) : (
            <select id="schedule-project" className="schedule-input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}

          <label className="schedule-label" htmlFor="schedule-text">
            Prompt
          </label>
          <textarea
            id="schedule-text"
            className="schedule-input"
            rows={5}
            autoFocus={!text}
            value={text}
            placeholder="What Claude should do then, e.g. Check that the new events arrive in analytics"
            onChange={(e) => setText(e.target.value)}
          />

          <span className="schedule-label">When</span>
          <div className="schedule-when">
            <div className="schedule-picks">
              {picks.map((p) => (
                <button key={p.label} className="btn btn-secondary" aria-pressed={at === p.at} onClick={() => setAt(p.at)}>
                  {p.label}
                </button>
              ))}
            </div>
            <input
              id="schedule-at"
              className="schedule-input"
              type="datetime-local"
              aria-label="Date and time"
              value={at === null ? '' : toLocalInput(at)}
              onChange={(e) => setAt(e.target.value ? new Date(e.target.value).getTime() : null)}
            />
            <span className="settings-desc">
              <Clock size={11} /> {at === null ? 'Pick a date' : past ? 'In the past: it will be due right away' : whenLabel(at)} · Orchia reminds you, and runs nothing on its own. It has to be open at that time.
            </span>
          </div>

          {error && <p className="schedule-error">{error}</p>}
        </div>
        <footer className="schedule-foot">
          {existing && (
            <button className="btn btn-ghost" disabled={busy} title="Remove it without running it" onClick={() => api.skipScheduled(existing.id).then(onClose, (e) => setError(e.message))}>
              Delete
            </button>
          )}
          <span className="pane-spacer" />
          {existing && (
            <button
              className="btn btn-secondary"
              disabled={busy || text !== existing.text}
              title={text !== existing.text ? 'Save the new text first' : "Puts the prompt in Up next of the project's newest session, or of a new one"}
              onClick={() => api.runScheduled(existing.id).then(({ sessionId }) => onOpenSession(sessionId), (e) => setError(e.message))}
            >
              Run now
            </button>
          )}
          <button className="btn btn-primary" disabled={busy || !projectId} onClick={save}>
            {existing ? 'Save' : 'Schedule'}
          </button>
        </footer>
      </div>
    </div>
  );
}

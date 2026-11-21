import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './projects.ts';

/**
 * Scheduled: prompts kept for a date, per project (sessions come and go, the project stays).
 * When one comes due Orchia reminds the user; with `run` on, it will hand it to Up next itself.
 * One that came due while Orchia was closed is "missed": it is never run late on its own.
 */

const STORE_FILE = join(CONFIG_DIR, 'schedule.json');
/** Due less than this long before Orchia started: still due, not missed (a quick restart). */
export const MISSED_AFTER_MS = 10 * 60 * 1000;
const MAX_TEXT = 20_000;
const MAX_TITLE = 120;

export type ScheduledState = 'waiting' | 'due' | 'missed';

export interface ScheduledItem {
  id: string;
  projectId: string;
  /** What the list shows; the first line of the prompt unless given. */
  title: string;
  /** The prompt sent to Claude. */
  text: string;
  /** When, in ms since the epoch: stored absolute, shown in local time. */
  at: number;
  /** Hand it to Up next by itself when due; otherwise only remind. */
  run: boolean;
  state: ScheduledState;
  createdAt: number;
}

export type ScheduledInput = Pick<ScheduledItem, 'projectId' | 'title' | 'text' | 'at' | 'run'>;
export type ScheduledPatch = Partial<Pick<ScheduledItem, 'title' | 'text' | 'at' | 'run'>>;

/** The title shown for a prompt: its first non-empty line, without Markdown heading marks. */
export function titleOf(text: string): string {
  const line = text.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '';
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line;
}

/** Checks a request body for a new item, or for a change (`partial`); throws with a message for the user. */
export function parseScheduled(body: any, partial: false): ScheduledInput;
export function parseScheduled(body: any, partial: true): ScheduledPatch;
export function parseScheduled(body: any, partial: boolean): ScheduledInput | ScheduledPatch {
  const out: ScheduledPatch & { projectId?: string } = {};
  if (!partial || 'text' in body) {
    const text = typeof body.text === 'string' ? body.text.replace(/\r\n/g, '\n').trim() : '';
    if (!text) throw new Error('Write the prompt to schedule');
    if (text.length > MAX_TEXT) throw new Error(`The prompt is too long (max ${MAX_TEXT} characters)`);
    out.text = text;
  }
  if (!partial || 'title' in body) {
    const title = typeof body.title === 'string' ? body.title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) : '';
    if (title) out.title = title;
    else if (out.text) out.title = titleOf(out.text);
  }
  if (!partial || 'at' in body) {
    if (typeof body.at !== 'number' || !Number.isFinite(body.at) || body.at <= 0) throw new Error('Pick a date');
    out.at = Math.round(body.at);
  }
  if (!partial || 'run' in body) {
    if ('run' in body && typeof body.run !== 'boolean') throw new Error('run must be true or false');
    out.run = body.run === true;
  }
  if (!partial) {
    if (typeof body.projectId !== 'string' || !body.projectId) throw new Error('Pick a project');
    out.projectId = body.projectId;
  }
  return out as ScheduledInput | ScheduledPatch;
}

export class ScheduleStore {
  private items: ScheduledItem[] = [];

  /** `startedAt`: when Orchia started; what came due well before it was missed while Orchia was closed. */
  constructor(
    private file = STORE_FILE,
    startedAt = Date.now(),
  ) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(saved?.items)) this.items = saved.items.filter(isItem);
    } catch {}
    let changed = false;
    for (const item of this.items) {
      if (item.state === 'waiting' && item.at <= startedAt - MISSED_AFTER_MS) {
        item.state = 'missed';
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /** Soonest first. */
  list(): ScheduledItem[] {
    return [...this.items].sort((a, b) => a.at - b.at);
  }

  get(id: string): ScheduledItem | undefined {
    return this.items.find((i) => i.id === id);
  }

  add(input: ScheduledInput, now = Date.now()): ScheduledItem {
    const item: ScheduledItem = { id: randomUUID(), ...input, state: input.at <= now ? 'due' : 'waiting', createdAt: now };
    this.items.push(item);
    this.save();
    return item;
  }

  /** A new date (snooze, reschedule) puts it back to waiting, or due if that date has passed. */
  update(id: string, patch: ScheduledPatch, now = Date.now()): ScheduledItem | undefined {
    const item = this.get(id);
    if (!item) return undefined;
    Object.assign(item, patch);
    if (patch.at !== undefined) item.state = patch.at <= now ? 'due' : 'waiting';
    this.save();
    return item;
  }

  /** Run or skipped: it leaves the list. */
  remove(id: string): ScheduledItem | undefined {
    const item = this.get(id);
    if (!item) return undefined;
    this.items = this.items.filter((i) => i !== item);
    this.save();
    return item;
  }

  /** The project is gone: its items go with it. */
  removeProject(projectId: string) {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.projectId !== projectId);
    if (this.items.length !== before) this.save();
  }

  /** Marks what has come due; returns those items, oldest first. */
  tick(now = Date.now()): ScheduledItem[] {
    const due = this.items.filter((i) => i.state === 'waiting' && i.at <= now).sort((a, b) => a.at - b.at);
    for (const item of due) item.state = 'due';
    if (due.length) this.save();
    return due;
  }

  private save() {
    try {
      writeFileSync(this.file, JSON.stringify({ items: this.items }, null, 2));
    } catch (err) {
      console.warn(`Could not save ${this.file}: ${(err as Error).message}`);
    }
  }
}

function isItem(v: any): v is ScheduledItem {
  return (
    v &&
    typeof v.id === 'string' &&
    typeof v.projectId === 'string' &&
    typeof v.text === 'string' &&
    typeof v.title === 'string' &&
    typeof v.at === 'number' &&
    typeof v.run === 'boolean' &&
    (v.state === 'waiting' || v.state === 'due' || v.state === 'missed')
  );
}

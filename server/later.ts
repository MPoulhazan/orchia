import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './projects.ts';

/**
 * Security alerts put off with "Later": out of Needs you on this computer, without a decision.
 * Kept apart from the triage decisions, which Orchia Cloud gets: there, the alert stays open.
 * A secret comes back as soon as it is seen again; anything else after a while, in case the
 * problem went away and came back.
 */

const STORE_FILE = join(CONFIG_DIR, 'later.json');
const LATER_FOR_MS = 30 * 24 * 60 * 60 * 1000;

export class LaterStore {
  private keys: Record<string, number> = {};

  constructor(private file = STORE_FILE) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved && typeof saved.keys === 'object') this.keys = saved.keys;
    } catch {}
  }

  /** Put off: out of Needs you. `lastSeenAt` (a secret's) brings it back once it is seen after that. */
  isLater(key: string, lastSeenAt?: number, now = Date.now()): boolean {
    const at = this.keys[key];
    if (at === undefined || now - at > LATER_FOR_MS) return false;
    return lastSeenAt === undefined || lastSeenAt <= at;
  }

  set(key: string, later: boolean, now = Date.now()) {
    if (later) this.keys[key] = now;
    else delete this.keys[key];
    for (const [k, at] of Object.entries(this.keys)) if (now - at > LATER_FOR_MS) delete this.keys[k];
    try {
      writeFileSync(this.file, JSON.stringify({ keys: this.keys }, null, 2));
    } catch (err) {
      console.warn(`Could not save ${this.file}: ${(err as Error).message}`);
    }
  }
}

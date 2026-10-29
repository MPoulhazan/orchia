import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './projects.ts';

/**
 * What the user decided about a security alert, so alerts don't pile up unread. An alert is
 * open until it is fixed (on its own for a CVE or a setting, once the problem is gone; by hand
 * for a secret, which only the user can revoke), accepted as a risk (with a note, for 90 days,
 * then it comes back once to be looked at again) or marked a false positive (for good).
 * Decisions are kept by the alert's key, the same one Orchia Cloud gets.
 */

export type TriageStatus = 'accepted' | 'false-positive';

export interface Triage {
  status: TriageStatus;
  /** Why: required to accept a risk, optional for a false positive. */
  note: string;
  at: number;
  /** When an accepted risk comes back to be looked at again; null for a false positive. */
  expiresAt: number | null;
}

export const ACCEPT_FOR_MS = 90 * 24 * 60 * 60 * 1000;
export const MAX_NOTE = 200;

// One key per alert, stable while the problem lasts. A shared one (the user's settings, a connector
// every project gets) has no project in its key: deciding about it once covers every project.
export const secretKey = (fingerprint: string) => `secret:${fingerprint}`;
export const configKey = (projectId: string, riskId: string, shared: boolean) => `config:${shared ? '' : `${projectId}:`}${riskId}`;
export const cveKey = (projectId: string, connector: string, advisoryIds: string[], shared: boolean) =>
  `cve:${shared ? '' : `${projectId}:`}${connector}:${advisoryIds.join(',')}`;

const STORE_FILE = join(CONFIG_DIR, 'triage.json');

export class TriageStore {
  private decisions: Record<string, Triage> = {};

  constructor(private file = STORE_FILE) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved && typeof saved.decisions === 'object') this.decisions = saved.decisions;
    } catch {}
  }

  /** The decision in force for an alert; null when it is open, including an accepted risk that expired. */
  get(key: string, now = Date.now()): Triage | null {
    const t = this.decisions[key];
    if (!t) return null;
    if (t.expiresAt !== null && t.expiresAt <= now) return null;
    return t;
  }

  /** Throws on a missing note for an accepted risk. */
  set(key: string, status: TriageStatus, note: string, now = Date.now()) {
    const text = note.trim().slice(0, MAX_NOTE);
    if (status === 'accepted' && !text) throw new Error('Say why the risk is accepted.');
    this.decisions[key] = { status, note: text, at: now, expiresAt: status === 'accepted' ? now + ACCEPT_FOR_MS : null };
    this.save(now);
  }

  /** Opens the alert again. */
  clear(key: string) {
    if (!(key in this.decisions)) return;
    delete this.decisions[key];
    this.save();
  }

  private save(now = Date.now()) {
    // An accepted risk that expired is open again: its old decision has nothing left to say.
    for (const [key, t] of Object.entries(this.decisions)) if (t.expiresAt !== null && t.expiresAt <= now) delete this.decisions[key];
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ decisions: this.decisions }, null, 2));
      renameSync(tmp, this.file);
    } catch (err) {
      console.warn(`Could not save ${this.file}: ${(err as Error).message}`);
    }
  }
}

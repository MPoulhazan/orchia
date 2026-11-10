import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Token diet changes asked from Orchia Cloud's Usage page, kept so they can be undone from there:
 * which connectors were turned off in which project. Only what this computer did is kept here.
 */

export interface DietAction {
  projectId: string;
  /** The finding it answered, e.g. `unused-connectors`. */
  key: string;
  /** Claude Code's names of the connectors turned off. */
  names: string[];
  at: number;
}

export class DietActionStore {
  private readonly file: string;
  private actions: DietAction[] = [];

  constructor(private readonly dir: string) {
    this.file = join(dir, 'diet-actions.json');
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      this.actions = Array.isArray(raw)
        ? raw.filter((a) => typeof a?.projectId === 'string' && typeof a.key === 'string' && Array.isArray(a.names) && typeof a.at === 'number')
        : [];
    } catch (err) {
      console.error(`Could not read ${this.file}:`, err);
    }
  }

  list(): DietAction[] {
    return this.actions;
  }

  get(projectId: string, key: string): DietAction | undefined {
    return this.actions.find((a) => a.projectId === projectId && a.key === key);
  }

  /** A second change to the same finding adds its connectors to the first, so one undo brings all back. */
  add(action: DietAction) {
    const known = this.get(action.projectId, action.key);
    if (known) {
      known.names = [...new Set([...known.names, ...action.names])];
      known.at = action.at;
    } else this.actions.push(action);
    this.save();
  }

  remove(projectId: string, key: string) {
    this.actions = this.actions.filter((a) => !(a.projectId === projectId && a.key === key));
    this.save();
  }

  /** Projects removed from Orchia take their undo with them. */
  keepProjects(ids: Set<string>) {
    const kept = this.actions.filter((a) => ids.has(a.projectId));
    if (kept.length === this.actions.length) return;
    this.actions = kept;
    this.save();
  }

  private save() {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.actions, null, 2));
    renameSync(tmp, this.file);
  }
}

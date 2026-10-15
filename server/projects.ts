import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export interface Project {
  id: string;
  name: string;
  path: string;
  addedAt: number;
  /** Suggested skills turned down with ✕. */
  dismissedSkills?: string[];
  /** Where a new session works while another one is busy in the folder; `ask` when missing. */
  copyMode?: CopyMode;
}

export type CopyMode = 'ask' | 'copy' | 'same';
export const isCopyMode = (v: unknown): v is CopyMode => v === 'ask' || v === 'copy' || v === 'same';

interface Config {
  projects: Project[];
}

export const CONFIG_DIR = process.env.AGENTHUB_HOME ?? join(homedir(), '.agenthub');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

/** Absolute path with an upper-case drive letter, so the same folder always looks the same. */
export function fullPath(path: string): string {
  return resolve(path).replace(/^[a-z]:/, (d) => d.toUpperCase());
}

/** Windows paths are case-insensitive; compare them the way the OS does. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export class ProjectStore {
  private config: Config = { projects: [] };

  constructor() {
    if (!existsSync(CONFIG_FILE)) return;
    try {
      const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
      this.config.projects = Array.isArray(parsed.projects) ? parsed.projects : [];
    } catch (err) {
      console.error(`Could not read ${CONFIG_FILE}:`, err);
    }
  }

  list(): Project[] {
    return this.config.projects;
  }

  get(id: string): Project | undefined {
    return this.config.projects.find((p) => p.id === id);
  }

  add(path: string): Project {
    const full = fullPath(path.trim());
    if (!isDirectory(full)) throw new Error('Folder not found');
    const existing = this.config.projects.find((p) => samePath(p.path, full));
    if (existing) return existing;
    const project: Project = { id: randomUUID(), name: basename(full) || full, path: full, addedAt: Date.now() };
    this.config.projects.push(project);
    this.save();
    return project;
  }

  dismissSkill(id: string, name: string) {
    const project = this.get(id);
    if (!project) throw new Error('Project not found');
    project.dismissedSkills = [...new Set([...(project.dismissedSkills ?? []), name])];
    this.save();
  }

  setCopyMode(id: string, mode: CopyMode) {
    const project = this.get(id);
    if (!project) throw new Error('Project not found');
    if (mode === 'ask') delete project.copyMode;
    else project.copyMode = mode;
    this.save();
  }

  remove(id: string) {
    this.config.projects = this.config.projects.filter((p) => p.id !== id);
    this.save();
  }

  private save() {
    mkdirSync(CONFIG_DIR, { recursive: true });
    const tmp = `${CONFIG_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.config, null, 2));
    renameSync(tmp, CONFIG_FILE);
  }
}

import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { samePath, type Project } from './projects.ts';
import { cleanEnv } from './session.ts';

/**
 * Skills a session can use, and how to add or turn them off.
 *
 * Claude Code has no per-session skills: a skill lives in the project
 * (`.claude/skills`) or in `~/.claude/skills` for every project, and plugins are
 * installed for a project or for the user. So everything here is per project.
 * Turning something off is per project too, in `.claude/settings.local.json`:
 * `skillOverrides` for skills, `enabledPlugins` (through the CLI) for plugins.
 * Claude Code picks up skill changes live; plugins need `/reload-plugins`.
 */

export type SkillScope = 'project' | 'all';

export interface Skill {
  /** `skill:<name>` or `plugin:<plugin id>`. */
  id: string;
  kind: 'skill' | 'plugin';
  name: string;
  description: string;
  scope: SkillScope;
  enabled: boolean;
  /** Plugins: how many skills they bring. */
  skillCount?: number;
}

/** A skill another project has, which this one could copy. */
export interface SkillElsewhere {
  name: string;
  description: string;
  project: string;
  path: string;
}

export interface CatalogPlugin {
  id: string;
  name: string;
  description: string;
  installs: number;
}

const PERSONAL_DIR = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'skills');
const projectSkillsDir = (cwd: string) => join(cwd, '.claude', 'skills');
const localSettingsFile = (cwd: string) => join(cwd, '.claude', 'settings.local.json');

/** Where a new skill goes: the project's folder, or the personal one for every project. */
export const skillsDir = (cwd: string, scope: SkillScope) => (scope === 'all' ? PERSONAL_DIR : projectSkillsDir(cwd));

// ---- Reading skills -------------------------------------------------------------

interface SkillFile {
  name: string;
  description: string;
  path: string;
}

/** The skills directly under a skills folder: one sub-folder with a SKILL.md each. */
function readSkillsDir(dir: string): SkillFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((folder) => {
    const path = join(dir, folder);
    try {
      const meta = frontmatter(readFileSync(join(path, 'SKILL.md'), 'utf8'));
      return [{ name: meta.name || folder, description: meta.description ?? '', path }];
    } catch {
      return [];
    }
  });
}

/** The `key: value` pairs of a SKILL.md header, enough for name and description. */
export function frontmatter(text: string): Record<string, string> {
  const match = text.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const out: Record<string, string> = {};
  let key: string | null = null;
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([\w-]+):\s*(.*)$/);
    if (pair) {
      key = pair[1];
      const value = pair[2].trim();
      // `>` and `|` start a block; its lines follow, indented.
      out[key] = /^[>|][+-]?$/.test(value) ? '' : value.replace(/^(['"])(.*)\1$/, '$2');
    } else if (key && /^\s+\S/.test(line)) {
      out[key] = `${out[key]} ${line.trim()}`.trim();
    }
  }
  return out;
}

export function readJsonFile(file: string): any {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function writeJsonFile(file: string, data: unknown) {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, file);
}

// ---- The Claude Code CLI ----------------------------------------------------------

/** Runs `claude plugin …` in the project and returns its --json output. */
function claudePlugin(cwd: string, args: string[]): Promise<any> {
  const command = process.env.AGENTHUB_CLAUDE_CLI ?? 'claude';
  return new Promise((resolve, reject) => {
    // Plugin ids and scopes only: nothing that needs quoting for the shell.
    execFile(
      command,
      ['plugin', ...args, '--json'],
      { cwd, env: cleanEnv(), shell: process.platform === 'win32', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        const line = stdout.trim().split('\n').filter(Boolean).at(-1) ?? '';
        let result: any = null;
        try {
          // `list` prints pretty JSON on several lines; the others print one line.
          result = JSON.parse(args[0] === 'list' ? stdout : line);
        } catch {
          // Fall through to the error below.
        }
        if (result && result.outcome !== 'failed') return resolve(result);
        reject(new Error(result?.message ?? (err as Error | null)?.message ?? 'claude plugin failed'));
      },
    );
  });
}

interface InstalledPlugin {
  id: string;
  scope: 'user' | 'project' | 'local';
  enabled: boolean;
  installPath: string;
  projectPath?: string;
}

const installedCache = new Map<string, { at: number; plugins: InstalledPlugin[] }>();
const INSTALLED_TTL_MS = 20_000;

/** Installed plugins as seen from the project (enabled depends on its settings). */
async function installedPlugins(cwd: string): Promise<InstalledPlugin[]> {
  const key = cwd.toLowerCase();
  const hit = installedCache.get(key);
  if (hit && Date.now() - hit.at < INSTALLED_TTL_MS) return hit.plugins;
  const plugins: InstalledPlugin[] = await claudePlugin(cwd, ['list']).catch(() => []);
  installedCache.set(key, { at: Date.now(), plugins });
  return plugins;
}

let catalog: { at: number; plugins: CatalogPlugin[] } | null = null;
const CATALOG_TTL_MS = 10 * 60_000;

/** Plugins from the marketplaces Claude Code knows, most installed first. Cached: the CLI takes a few seconds. */
export async function pluginCatalog(cwd: string): Promise<CatalogPlugin[]> {
  if (catalog && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog.plugins;
  const result = await claudePlugin(cwd, ['list', '--available']);
  const plugins: CatalogPlugin[] = (result.available ?? []).map((p: any) => ({
    id: String(p.pluginId),
    name: String(p.name),
    description: String(p.description ?? ''),
    installs: Number(p.installCount ?? 0),
  }));
  plugins.sort((a, b) => b.installs - a.installs);
  catalog = { at: Date.now(), plugins };
  return plugins;
}

// ---- What a project has -------------------------------------------------------------

export async function projectSkills(cwd: string): Promise<Skill[]> {
  const overrides = {
    ...readJsonFile(join(PERSONAL_DIR, '..', 'settings.json'))?.skillOverrides,
    ...readJsonFile(join(cwd, '.claude', 'settings.json'))?.skillOverrides,
    ...readJsonFile(localSettingsFile(cwd))?.skillOverrides,
  };
  const skill = (s: SkillFile, scope: SkillScope): Skill => ({
    id: `skill:${s.name}`,
    kind: 'skill',
    name: s.name,
    description: s.description,
    scope,
    enabled: overrides[s.name] !== 'off',
  });
  // A personal skill wins over a project one with the same name.
  const personal = readSkillsDir(PERSONAL_DIR).map((s) => skill(s, 'all'));
  const own = readSkillsDir(projectSkillsDir(cwd))
    .filter((s) => !personal.some((p) => p.name === s.name))
    .map((s) => skill(s, 'project'));

  const installed = await installedPlugins(cwd);
  const known = catalog?.plugins ?? [];
  const plugins = installed
    .filter((p) => p.scope === 'user' || (p.projectPath && samePath(p.projectPath, cwd)))
    .map((p): Skill => {
      const name = p.id.split('@')[0];
      const manifest = readJsonFile(join(p.installPath, '.claude-plugin', 'plugin.json'));
      return {
        id: `plugin:${p.id}`,
        kind: 'plugin',
        name,
        description: manifest?.description ?? known.find((k) => k.id === p.id)?.description ?? '',
        scope: p.scope === 'user' ? 'all' : 'project',
        enabled: p.enabled,
        skillCount: readSkillsDir(join(p.installPath, 'skills')).length,
      };
    });

  return [...own, ...personal, ...plugins].sort((a, b) => a.name.localeCompare(b.name));
}

/** Skills in the other projects' folders that this project doesn't have yet. */
export function skillsElsewhere(cwd: string, projects: Project[], have: Skill[]): SkillElsewhere[] {
  const seen = new Set(have.map((s) => s.name));
  const out: SkillElsewhere[] = [];
  for (const project of projects) {
    if (samePath(project.path, cwd)) continue;
    for (const s of readSkillsDir(projectSkillsDir(project.path))) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      out.push({ ...s, project: project.name });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---- Changes ----------------------------------------------------------------------

/** On or off for this project only, whatever the skill's scope. */
export async function setEnabled(cwd: string, id: string, on: boolean) {
  const [kind, ...rest] = id.split(':');
  const name = rest.join(':');
  if (kind === 'plugin') {
    await claudePlugin(cwd, [on ? 'enable' : 'disable', name, '--scope', 'local']);
    installedCache.clear();
    return;
  }
  const file = localSettingsFile(cwd);
  const settings = readJsonFile(file) ?? {};
  const overrides = { ...settings.skillOverrides };
  if (on) delete overrides[name];
  else overrides[name] = 'off';
  if (Object.keys(overrides).length) settings.skillOverrides = overrides;
  else delete settings.skillOverrides;
  writeJsonFile(file, settings);
}

/** Copies another project's skill into this project, or into the personal folder. */
export function copySkill(cwd: string, from: string, scope: SkillScope) {
  if (!existsSync(join(from, 'SKILL.md'))) throw new Error('That skill is gone');
  const target = join(skillsDir(cwd, scope), basename(from));
  if (existsSync(target)) throw new Error(`A skill named ${basename(from)} is already there`);
  cpSync(from, target, { recursive: true });
}

export async function installPlugin(cwd: string, id: string, scope: SkillScope) {
  await claudePlugin(cwd, ['install', id, '--scope', scope === 'all' ? 'user' : 'project']);
  installedCache.clear();
}

/** The prompt for a session that writes a new skill from a description. */
export function newSkillPrompt(cwd: string, description: string, scope: SkillScope): string {
  const dir = skillsDir(cwd, scope).replace(/\\/g, '/');
  return (
    `Create a new Claude Code skill in ${dir}/<skill-name>/SKILL.md. What it should do: ${description.replace(/\s+/g, ' ').trim()}. ` +
    'Pick a short kebab-case name. Start SKILL.md with YAML frontmatter holding name and a description that says what the skill does and when to use it. ' +
    'Keep the instructions concise and add helper files only if they are really needed. Ask me if something important is unclear.'
  );
}

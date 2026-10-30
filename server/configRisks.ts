import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Permission settings that let Claude do more than you would think without asking: an allow
 * rule for every shell command, permission prompts skipped altogether, or `.env` files that
 * Claude can read (and so send to the model) without a deny rule. Read from the same files
 * Claude Code reads: the user's settings, then the project's shared and local ones.
 */

export type RiskSeverity = 'moderate' | 'high';

export interface ConfigRisk {
  /** Stable for the same risk in the same file, to dismiss it. */
  id: string;
  severity: RiskSeverity;
  title: string;
  detail: string;
  /** The settings file it comes from, as the UI shows it. */
  file: string;
  /** Set in the user's settings: it applies to every project. */
  shared: boolean;
  /** What Orchia can do about it in one click, in the project's local settings; null: edit the file. */
  fix: 'remove-allow' | 'deny-env' | 'ignore-env' | null;
  /** The allow rule to remove, for `remove-allow`. */
  rule?: string;
  /** The files to add to .gitignore, for `ignore-env`. */
  files?: string[];
}

const userSettingsFile = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json');
const localFile = (cwd: string) => join(cwd, '.claude', 'settings.local.json');

/**
 * The rules added to the project's local settings by "Block .env reads": every `.env` file at
 * any depth. A glob can't leave the templates out, so `.env.example` is blocked too.
 */
export const ENV_DENY_RULES = ['Read(**/.env)', 'Read(**/.env.*)'];
/** Rules from Orchia before it looked in subfolders: they only cover the project's root. */
const ROOT_ENV_RULES = ['Read(./.env)', 'Read(./.env.*)'];

/** Shell rules that allow any command. */
const BROAD = /^(Bash|PowerShell)(\((\*|:\*|\*:\*)?\))?$/;
/** `.env`, `.env.local`, `.env.production`. */
const ENV_FILE = /^\.env(\.[\w.-]+)?$/;
/** Templates meant to be committed: `.env.example`, `.env.production.sample`. */
const ENV_TEMPLATE = /\.(example|sample|template|dist|defaults)$/i;
/** Variables bundled into the browser by design: a `.env` holding only these has no secret. */
const PUBLIC_VAR = /^(VITE_|NEXT_PUBLIC_|PUBLIC_|REACT_APP_|EXPO_PUBLIC_|NUXT_PUBLIC_|GATSBY_)/;
/** Folders not worth walking for `.env` files: dependencies, builds, caches. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'vendor', 'target', 'coverage', '.venv', 'venv', '__pycache__', '.turbo', '.cache']);
const ENV_DEPTH = 4;
const ENV_LIST_TTL_MS = 30_000;

export function isEnvFile(name: string): boolean {
  return ENV_FILE.test(name) && !ENV_TEMPLATE.test(name);
}

/** False for a `.env` that sets nothing, or only browser-public values (`VITE_…`). */
export function holdsSecrets(text: string): boolean {
  const vars = text
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^export\s+/, ''))
    .filter((l) => /^[A-Za-z_]\w*=\s*\S/.test(l));
  return vars.some((l) => !PUBLIC_VAR.test(l));
}

function readSettings(file: string): any {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) ?? null;
  } catch {
    return null;
  }
}

const rulesOf = (settings: any, list: 'allow' | 'deny'): string[] => {
  const rules = settings?.permissions?.[list];
  return Array.isArray(rules) ? rules.filter((r): r is string => typeof r === 'string') : [];
};

export function configRisks(cwd: string): ConfigRisk[] {
  const files = [
    { path: userSettingsFile(), label: '~/.claude/settings.json', shared: true, local: false },
    { path: join(cwd, '.claude', 'settings.json'), label: '.claude/settings.json', shared: false, local: false },
    { path: localFile(cwd), label: '.claude/settings.local.json', shared: false, local: true },
  ].map((f) => ({ ...f, settings: readSettings(f.path) }));

  const risks: ConfigRisk[] = [];
  for (const f of files) {
    if (!f.settings) continue;
    for (const rule of rulesOf(f.settings, 'allow').filter((r) => BROAD.test(r))) {
      risks.push({
        id: `broad-allow:${f.label}:${rule}`,
        severity: 'high',
        title: `Any shell command is allowed`,
        detail: `${rule} in ${f.label}: Claude runs every command without asking, including ones that delete files or send data out.`,
        file: f.label,
        shared: f.shared,
        fix: f.local ? 'remove-allow' : null,
        rule,
      });
    }
    if (f.settings?.permissions?.defaultMode === 'bypassPermissions') {
      risks.push({
        id: `bypass:${f.label}`,
        severity: 'high',
        title: 'Permission prompts are skipped',
        detail: `defaultMode is bypassPermissions in ${f.label}: Claude never asks before running a command or editing a file.`,
        file: f.label,
        shared: f.shared,
        fix: null,
      });
    }
  }

  const deny = files.flatMap((f) => rulesOf(f.settings, 'deny'));
  const everywhere = ENV_DENY_RULES.every((r) => deny.includes(r));
  const atRoot = everywhere || ROOT_ENV_RULES.every((r) => deny.includes(r));
  // Covered by the rules for every depth, or by the old root-only ones for a file at the root.
  const readable = listEnvFiles(cwd).filter((f) => !(everywhere || (atRoot && !f.includes('/'))));
  if (readable.length) {
    risks.push({
      id: 'env-readable',
      severity: 'moderate',
      title: '.env files can be read',
      detail: `${readable.slice(0, 3).join(', ')}${readable.length > 3 ? '…' : ''}: no deny rule stops Claude from reading ${readable.length > 1 ? 'them' : 'it'} and sending the secrets to the model.`,
      file: '.claude/settings.local.json',
      shared: false,
      fix: 'deny-env',
    });
  }
  return risks;
}

const envLists = new Map<string, { at: number; files: string[] }>();

/** The project's `.env` files that hold secrets, as `frontend/.env.local`; cached briefly, as this runs on every state change. */
function listEnvFiles(cwd: string): string[] {
  const cached = envLists.get(cwd);
  if (cached && Date.now() - cached.at < ENV_LIST_TTL_MS) return cached.files;
  const files: string[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && depth < ENV_DEPTH && !SKIP_DIRS.has(e.name)) walk(join(dir, e.name), path, depth + 1);
      else if (e.isFile() && isEnvFile(e.name)) {
        try {
          if (holdsSecrets(readFileSync(join(dir, e.name), 'utf8'))) files.push(path);
        } catch {}
      }
    }
  };
  walk(cwd, '', 0);
  files.sort();
  envLists.set(cwd, { at: Date.now(), files });
  return files;
}

/** The project's settings deny Claude's reads of `.env` files: shell commands that print them are refused too. */
export function envReadsBlocked(cwd: string): boolean {
  const deny = [userSettingsFile(), join(cwd, '.claude', 'settings.json'), localFile(cwd)].flatMap((f) => rulesOf(readSettings(f), 'deny'));
  return ENV_DENY_RULES.every((r) => deny.includes(r)) || ROOT_ENV_RULES.every((r) => deny.includes(r));
}

/** Programs that print a file's content to Claude. `source .env` and dotenv runners load it without showing it. */
const PRINTS = /^(cat|head|tail|less|more|type|bat|nl|strings|xxd|od|grep|egrep|rg|awk|sed|cut|sort|uniq|get-content|gc|select-string|findstr)$/i;

/** The `.env` file a shell command would print, such as `cat frontend/.env.local`; null otherwise. */
export function printedEnvFile(command: unknown): string | null {
  if (typeof command !== 'string') return null;
  // Each simple command of a pipeline or list.
  for (const part of command.split(/[|;&\n]+/)) {
    const words = part.trim().split(/\s+/);
    const program = (words[0] ?? '').replace(/^.*[\\/]/, '');
    if (!PRINTS.test(program)) continue;
    const file = words
      .slice(1)
      .map((w) => w.replace(/^['"]|['"]$/g, ''))
      .find((w) => isEnvFile(w.replace(/^.*[\\/]/, '')));
    if (file) return file;
  }
  return null;
}

/** Adds the `.env` deny rules to the project's local settings, the file Claude Code keeps out of git. */
export function denyEnvReads(cwd: string) {
  const file = localFile(cwd);
  let settings: any = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, 'utf8')) ?? {};
    } catch {
      throw new Error(`${file} is not valid JSON; fix it by hand first.`);
    }
  }
  settings.permissions ??= {};
  const deny = rulesOf(settings, 'deny');
  settings.permissions.deny = [...deny, ...ENV_DENY_RULES.filter((r) => !deny.includes(r))];
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}

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
  fix: 'remove-allow' | 'deny-env' | null;
  /** The allow rule to remove, for `remove-allow`. */
  rule?: string;
}

const userSettingsFile = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json');
const localFile = (cwd: string) => join(cwd, '.claude', 'settings.local.json');

/** The rules added to the project's local settings by "Block .env reads". */
export const ENV_DENY_RULES = ['Read(./.env)', 'Read(./.env.*)'];

/** Shell rules that allow any command. */
const BROAD = /^(Bash|PowerShell)(\((\*|:\*|\*:\*)?\))?$/;
/** `.env`, `.env.local`, `.env.production`; not the templates meant to be committed. */
const ENV_FILE = /^\.env(\.(?!example$|sample$|template$|dist$|defaults$)[\w.-]+)?$/;

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

  const envFiles = listEnvFiles(cwd);
  const denied = files.some((f) => rulesOf(f.settings, 'deny').some((r) => /^Read\(.*\.env/.test(r)));
  if (envFiles.length && !denied) {
    risks.push({
      id: 'env-readable',
      severity: 'moderate',
      title: '.env files can be read',
      detail: `${envFiles.slice(0, 3).join(', ')}${envFiles.length > 3 ? '…' : ''}: no deny rule stops Claude from reading ${envFiles.length > 1 ? 'them' : 'it'} and sending the secrets to the model.`,
      file: '.claude/settings.local.json',
      shared: false,
      fix: 'deny-env',
    });
  }
  return risks;
}

function listEnvFiles(cwd: string): string[] {
  try {
    return readdirSync(cwd, { withFileTypes: true })
      .filter((e) => e.isFile() && ENV_FILE.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isEffortLevel, isModelAlias } from './models.ts';

/** `claude --permission-mode` values offered in Orchia. */
export const PERMISSION_MODES = ['manual', 'acceptEdits', 'plan', 'auto'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** What a phone may answer through Orchia Cloud: everything, everything but shell commands, or Deny only. */
export const REMOTE_ANSWERS = ['all', 'no-shell', 'deny-only'] as const;
export type RemoteAnswers = (typeof REMOTE_ANSWERS)[number];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return PERMISSION_MODES.includes(value as any);
}

/** What new sessions start with (null keeps Claude Code's own default), and what Orchia does on its own. */
export interface Settings {
  model: string | null;
  effort: string | null;
  permissionMode: PermissionMode | null;
  /** Before sending the next Up next prompt, type /compact when the context is well filled. */
  compactBetweenTasks: boolean;
  /** After a connector change, restart the project's sessions once Claude is free, keeping the conversation. */
  restartAfterConnectorChange: boolean;
  /** Once paired, send what needs you (waiting sessions, permission requests, end summaries) to Orchia Cloud. */
  remoteNeeds: boolean;
  remoteAnswers: RemoteAnswers;
  /** Once paired, send the security alerts (CVEs, secrets that reached the model, risky settings) to Orchia Cloud. */
  remoteSecurity: boolean;
}

const DEFAULTS: Settings = {
  model: null,
  effort: null,
  permissionMode: null,
  compactBetweenTasks: true,
  restartAfterConnectorChange: true,
  remoteNeeds: false,
  remoteAnswers: 'all',
  remoteSecurity: false,
};

/** Keeps known values only, so a hand-edited or older file never breaks a launch. */
function clean(raw: any): Settings {
  return {
    model: isModelAlias(raw?.model) ? raw.model : null,
    effort: isEffortLevel(raw?.effort) ? raw.effort : null,
    permissionMode: isPermissionMode(raw?.permissionMode) ? raw.permissionMode : null,
    compactBetweenTasks: raw?.compactBetweenTasks !== false,
    restartAfterConnectorChange: raw?.restartAfterConnectorChange !== false,
    remoteNeeds: raw?.remoteNeeds === true,
    remoteAnswers: REMOTE_ANSWERS.includes(raw?.remoteAnswers) ? raw.remoteAnswers : 'all',
    remoteSecurity: raw?.remoteSecurity === true,
  };
}

export class SettingsStore {
  private readonly file: string;
  private settings: Settings = { ...DEFAULTS };

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'settings.json');
    if (!existsSync(this.file)) return;
    try {
      this.settings = clean(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch (err) {
      console.error(`Could not read ${this.file}:`, err);
    }
  }

  get(): Settings {
    return { ...this.settings };
  }

  /** Throws on an unknown value instead of silently dropping it. */
  update(patch: Partial<Settings>) {
    const next = { ...this.settings, ...patch };
    if (next.model !== null && !isModelAlias(next.model)) throw new Error('Unknown model');
    if (next.effort !== null && !isEffortLevel(next.effort)) throw new Error('Unknown effort level');
    if (next.permissionMode !== null && !isPermissionMode(next.permissionMode)) throw new Error('Unknown permission mode');
    if (typeof next.compactBetweenTasks !== 'boolean') throw new Error('compactBetweenTasks must be true or false');
    if (typeof next.restartAfterConnectorChange !== 'boolean') throw new Error('restartAfterConnectorChange must be true or false');
    if (typeof next.remoteNeeds !== 'boolean') throw new Error('remoteNeeds must be true or false');
    if (!REMOTE_ANSWERS.includes(next.remoteAnswers)) throw new Error('Unknown remoteAnswers value');
    if (typeof next.remoteSecurity !== 'boolean') throw new Error('remoteSecurity must be true or false');
    this.settings = next;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.settings, null, 2));
    renameSync(tmp, this.file);
  }
}

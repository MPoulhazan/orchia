import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PermissionRule } from './permissionRules.ts';

/**
 * Claude Code reports what it is doing through HTTP hooks injected with
 * `--settings`. They add to the user's own hooks instead of replacing them.
 * Each session gets its id and a secret token through environment variables,
 * which Claude Code interpolates into the request headers.
 *
 * PermissionRequest is the one hook that may answer: Orchia holds it until
 * the user allows or denies from the inbox or grid. Claude Code keeps showing its
 * own prompt meanwhile, and whichever answer comes first applies.
 *
 * The status line is the only place Claude Code gives out the session cost and
 * context window, so a relay script reports them (see statusline.mjs).
 */

export type Activity = 'starting' | 'working' | 'waiting' | 'idle';

export interface ActivityUpdate {
  activity: Activity;
  /** Short text explaining why the session needs you. */
  detail?: string;
}

// Tools that stop and wait for an answer from the user.
const ASKING_TOOLS = 'AskUserQuestion|ExitPlanMode';
// Notification types that mean the session is blocked on the user.
const WAITING_NOTIFICATIONS = new Set([
  'permission_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
]);

/** How long a permission can wait for an answer from Orchia, in seconds. */
export const PERMISSION_WAIT_S = 600;

// Forward slashes: on Windows, Claude Code runs the command through Git Bash.
const STATUS_LINE_SCRIPT = fileURLToPath(new URL('./statusline.mjs', import.meta.url)).replace(/\\/g, '/');

export function writeHookSettings(dir: string, port: number): string {
  const hook = {
    type: 'http',
    url: `http://127.0.0.1:${port}/api/hook`,
    timeout: 5,
    headers: {
      'X-Orchia-Session': '$ORCHIA_SESSION_ID',
      Authorization: 'Bearer $ORCHIA_TOKEN',
    },
    allowedEnvVars: ['ORCHIA_SESSION_ID', 'ORCHIA_TOKEN'],
  };
  const on = (matcher?: string, timeout = hook.timeout) => [{ ...(matcher ? { matcher } : {}), hooks: [{ ...hook, timeout }] }];

  const settings = {
    hooks: {
      UserPromptSubmit: on(),
      PreToolUse: on(ASKING_TOOLS),
      PermissionRequest: on(undefined, PERMISSION_WAIT_S),
      PostToolUse: on(),
      Notification: on([...WAITING_NOTIFICATIONS].join('|')),
      Stop: on(),
      StopFailure: on(),
      PostModelSwitch: on(),
      PreCompact: on(),
      PostCompact: on(),
      // Tells when a /clear typed before a lot is done.
      SessionStart: on('clear'),
    },
    statusLine: { type: 'command', command: `node "${STATUS_LINE_SCRIPT}" ${port}` },
  };

  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'claude-hooks.json');
  writeFileSync(file, JSON.stringify(settings, null, 2));
  return file;
}

/** Maps a hook payload to the session's new activity, or null to ignore it. */
export function activityFromHook(payload: any): ActivityUpdate | null {
  switch (payload?.hook_event_name) {
    case 'UserPromptSubmit':
    case 'PostToolUse':
      return { activity: 'working' };
    case 'PreToolUse':
      return { activity: 'waiting', detail: payload.tool_name === 'ExitPlanMode' ? 'Plan ready for review' : 'Claude has a question' };
    case 'PermissionRequest':
      return { activity: 'waiting', detail: payload.tool_name ? `Permission to use ${payload.tool_name}` : 'Permission needed' };
    case 'Notification':
      if (!WAITING_NOTIFICATIONS.has(payload.notification_type)) return null;
      return { activity: 'waiting', detail: payload.message || 'Needs your input' };
    case 'Stop':
      return { activity: 'idle' };
    case 'PreCompact':
      return payload.trigger === 'manual' ? { activity: 'working', detail: 'Compacting the conversation' } : null;
    case 'PostCompact':
      // An automatic compaction happens mid-turn, which goes on; a /compact ends there.
      return payload.trigger === 'manual' ? { activity: 'idle' } : null;
    case 'StopFailure':
      return { activity: 'idle', detail: `Stopped: ${String(payload.error ?? 'error').replace(/_/g, ' ')}` };
    default:
      return null;
  }
}

/** A permission request as the UI shows it: "Run" + `npm test`. */
export interface PermissionAsk {
  tool: string;
  verb: string;
  target: string;
}

/**
 * Permission requests Orchia can answer, described for the UI, or null for
 * those that need the conversation's context (questions, plans to review).
 */
export function permissionAsk(payload: any, cwd: string): PermissionAsk | null {
  const tool = String(payload?.tool_name ?? '');
  if (!tool || ASKING_TOOLS.split('|').includes(tool)) return null;
  const input = payload.tool_input ?? {};
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  const path = (v: unknown) => relativeTo(cwd, text(v));
  const ask = (verb: string, target: string) => ({ tool, verb, target: target.trim() });

  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return ask('Run', text(input.command));
    case 'Edit':
    case 'MultiEdit':
      return ask('Edit', path(input.file_path));
    case 'NotebookEdit':
      return ask('Edit', path(input.notebook_path));
    case 'Write':
      return ask('Write', path(input.file_path));
    case 'Read':
      return ask('Read', path(input.file_path));
    case 'WebFetch':
      return ask('Fetch', text(input.url));
    case 'WebSearch':
      return ask('Search the web for', text(input.query));
    case 'Glob':
    case 'Grep':
      return ask('Search', text(input.pattern));
  }
  const mcp = tool.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) return ask('Use', `${mcp[1]}: ${mcp[2]}`);
  return ask('Use', tool);
}

/** `file` relative to `dir` when inside it, with forward slashes; unchanged otherwise. */
function relativeTo(dir: string, file: string): string {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const base = norm(dir);
  const target = norm(file);
  const caseless = process.platform === 'win32';
  const same = (a: string, b: string) => (caseless ? a.toLowerCase() === b.toLowerCase() : a === b);
  return same(target.slice(0, base.length + 1), base + '/') ? target.slice(base.length + 1) : target;
}

/**
 * The body that answers a held PermissionRequest hook. `rules` are saved as the
 * project's allow rules, like answering "Yes, and don't ask again" in the terminal.
 */
export function permissionDecision(allow: boolean, rules: PermissionRule[] = []) {
  const save = rules.length ? { updatedPermissions: [{ type: 'addRules', rules, behavior: 'allow', destination: 'localSettings' }] } : {};
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: allow
        ? { behavior: 'allow', ...save }
        : // Stops the turn, like answering No in the terminal: Claude waits for instructions.
          { behavior: 'deny', message: 'The user denied this from Orchia.', interrupt: true },
    },
  };
}

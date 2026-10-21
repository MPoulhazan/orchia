import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IPty } from '@lydell/node-pty';
import type { Activity, ActivityUpdate, PermissionAsk } from './hooks.ts';
import type { PermissionMode } from './settings.ts';
import { describeRule, type PermissionRule, type RuleView } from './permissionRules.ts';
import { summarize, type TurnSummary } from './summary.ts';
import { copyInstructions, type SessionCopy } from './copies.ts';
import { nextPlan, usageFromStatusLine, userStatusLine, type PlanItem, type Usage } from './inspector.ts';

// These packages ship CommonJS entry points; load them through require.
const require = createRequire(import.meta.url);
const pty: typeof import('@lydell/node-pty') = require('@lydell/node-pty');
const { Terminal: HeadlessTerminal } = require('@xterm/headless') as typeof import('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize');

const SCROLLBACK = 5000;

/** `suspended`: restored after a server restart, resumes the conversation on demand. */
export type SessionStatus = 'running' | 'exited' | 'suspended';

export interface SessionInfo {
  id: string;
  projectId: string;
  name: string;
  cwd: string;
  status: SessionStatus;
  exitCode: number | null;
  /** When claude last exited, while the session is ended. */
  endedAt: number | null;
  createdAt: number;
  activity: Activity;
  detail: string | null;
  /** Claude finished or asked for something since the user last looked at it. */
  unseen: boolean;
  /** Model id that last answered (e.g. claude-opus-5-5), once known. */
  model: string | null;
  /** Launch choices made in Orchia; null means Claude Code's own default. */
  modelChoice: string | null;
  effortChoice: string | null;
  /** Permission mode claude was launched with; null means Claude Code's own default. */
  permissionMode: PermissionMode | null;
  /** The permission request Orchia can answer right now, oldest first. */
  permission: (PermissionAsk & { id: string; always: RuleView[] }) | null;
  /** What the last finished turn did; cleared when a new one starts. */
  summary: TurnSummary | null;
  /** Prompts sent one at a time when Claude finishes a turn. */
  queue: QueuedPrompt[];
  /**
   * Why the queue waits although Claude is idle: `typing`, there is text in Claude's
   * prompt; `stopped`, the last turn was interrupted or failed. Null otherwise.
   */
  queueHeld: 'typing' | 'stopped' | null;
  /** Set when the session works in its own copy of the repository; `cwd` is then the copy. */
  copy: SessionCopy | null;
}

export interface QueuedPrompt {
  id: string;
  text: string;
}

export interface LaunchChoices {
  modelChoice: string | null;
  effortChoice: string | null;
}

/** What survives a server restart. */
export interface SessionRecord extends Partial<LaunchChoices> {
  id: string;
  permissionMode?: PermissionMode | null;
  projectId: string;
  name: string;
  cwd: string;
  createdAt: number;
  claudeSessionId: string;
  exited: boolean;
  model?: string | null;
  summary?: TurnSummary | null;
  queue?: QueuedPrompt[];
  copy?: SessionCopy | null;
  usage?: Usage | null;
  plan?: PlanItem[];
  turns?: number;
}

/** A PermissionRequest hook kept open until someone answers it. */
interface HeldPermission extends PermissionAsk {
  id: string;
  /** Tool name and input, to recognize the call once it runs. */
  key: string;
  /** What "Always allow" saves: the rules Claude Code suggests for this request. */
  always: PermissionRule[];
  /** Answers the hook; null lets Claude Code's own prompt decide. */
  reply: (allow: boolean | null, always?: boolean) => void;
}

interface SessionOptions extends Partial<LaunchChoices> {
  projectId: string;
  cwd: string;
  name: string;
  hookSettings: string | null;
  permissionMode?: PermissionMode | null;
  cols?: number;
  rows?: number;
  /** Works in this copy instead of the project folder. */
  copy?: SessionCopy | null;
  /** Bring back a session from a previous server run, without starting claude yet. */
  restore?: SessionRecord;
}

/**
 * One claude process in a PTY. The PTY output is mirrored into a headless
 * terminal so a client connecting later (page reload, switching sessions)
 * receives the current screen instead of a raw replay of the byte stream.
 *
 * Events: 'data' (output chunk), 'reset' (new process), 'change' (info changed).
 */
export class Session extends EventEmitter {
  readonly id: string;
  readonly projectId: string;
  readonly cwd: string;
  readonly copy: SessionCopy | null;
  readonly createdAt: number;
  name: string;
  /** Claude Code's own conversation id, used to resume it with `--resume`. */
  claudeSessionId: string;
  status: SessionStatus;
  exitCode: number | null = null;
  endedAt: number | null = null;
  activity: Activity = 'starting';
  detail: string | null = null;
  unseen = false;
  model: string | null;
  modelChoice: string | null;
  effortChoice: string | null;
  /** Set at creation from the settings; Shift+Tab in the terminal changes it for the current run only. */
  readonly permissionMode: PermissionMode | null;
  /** Inspector data for the current conversation. */
  usage: Usage | null;
  plan: PlanItem[];
  turns: number;
  /** What the last finished turn did, from the Stop hook. */
  summary: TurnSummary | null;
  /** Files edited or written since the turn started. */
  private turnFiles = new Set<string>();
  queue: QueuedPrompt[];
  /** The last turn ended normally (Stop), so the next queued prompt may go. */
  private cleanStop = false;
  /** Last keystroke from the user, and roughly how much they typed into Claude's prompt since Enter. */
  private lastInputAt = 0;
  private draftLength = 0;
  private sendTimer: NodeJS.Timeout | null = null;
  /** The skill Claude last used, from the hooks. */
  lastSkill: { name: string; at: number } | null = null;
  /** The MCP server whose tool Claude last called, as in the tool name: `mcp__<server>__<tool>`. */
  lastConnector: { toolPrefix: string; at: number } | null = null;
  /** Shared with the hooks so only this session's claude can report its activity. */
  readonly token = randomBytes(24).toString('hex');

  private held: HeldPermission[] = [];
  private readonly hookSettings: string | null;
  private cols: number;
  private rows: number;
  private proc: IPty | null = null;
  private mirror!: InstanceType<typeof HeadlessTerminal>;
  private serializer!: InstanceType<typeof SerializeAddon>;

  constructor(opts: SessionOptions) {
    super();
    const restore = opts.restore;
    this.id = restore?.id ?? randomUUID();
    this.projectId = opts.projectId;
    this.copy = restore?.copy ?? opts.copy ?? null;
    this.cwd = this.copy?.path ?? opts.cwd;
    this.name = restore?.name ?? opts.name;
    this.createdAt = restore?.createdAt ?? Date.now();
    this.claudeSessionId = restore?.claudeSessionId ?? randomUUID();
    this.model = restore?.model ?? null;
    this.modelChoice = restore?.modelChoice ?? opts.modelChoice ?? null;
    this.effortChoice = restore?.effortChoice ?? opts.effortChoice ?? null;
    this.permissionMode = restore ? (restore.permissionMode ?? null) : (opts.permissionMode ?? null);
    this.usage = restore?.usage ?? null;
    this.plan = restore?.plan ?? [];
    this.turns = restore?.turns ?? 0;
    this.summary = restore?.summary ?? null;
    this.queue = restore?.queue ?? [];
    this.hookSettings = opts.hookSettings;
    this.cols = opts.cols ?? 120;
    this.rows = opts.rows ?? 32;
    this.resetMirror();

    if (restore) {
      this.status = restore.exited ? 'exited' : 'suspended';
    } else {
      this.status = 'running';
      this.spawn(false);
    }
  }

  private resetMirror() {
    this.mirror?.dispose();
    this.mirror = new HeadlessTerminal({ cols: this.cols, rows: this.rows, scrollback: SCROLLBACK, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.mirror.loadAddon(this.serializer);
  }

  private spawn(resume: boolean) {
    this.status = 'running';
    this.exitCode = null;
    this.endedAt = null;
    this.activity = 'starting';
    this.detail = null;
    this.unseen = false;

    const [file, args] = claudeCommand(this.hookSettings, [
      ...(resume ? ['--resume', this.claudeSessionId] : ['--session-id', this.claudeSessionId]),
      // Flags apply to this session only; /model would rewrite the user's default.
      ...(this.modelChoice ? ['--model', this.modelChoice] : []),
      ...(this.effortChoice ? ['--effort', this.effortChoice] : []),
      ...(this.permissionMode ? ['--permission-mode', this.permissionMode] : []),
      ...(this.copy ? ['--append-system-prompt', copyInstructions(this.copy)] : []),
    ]);
    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: {
        ...cleanEnv(),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        ORCHIA_SESSION_ID: this.id,
        ORCHIA_TOKEN: this.token,
        ORCHIA_USER_STATUSLINE: userStatusLine(this.cwd) ?? '',
      },
    });
    this.proc = proc;
    const mirror = this.mirror;

    // Emit only once the mirror has parsed the chunk, so a snapshot taken at any
    // moment followed by the live stream never drops or duplicates output.
    proc.onData((data) => {
      if (this.proc !== proc) return;
      mirror.write(data, () => this.emit('data', data));
    });
    proc.onExit(({ exitCode }) => {
      if (this.proc !== proc) return; // a restart already replaced this process
      this.proc = null;
      this.releasePermissions();
      this.status = 'exited';
      this.exitCode = exitCode;
      this.endedAt = Date.now();
      // Queue behind pending output so clients see the last lines before the change.
      mirror.write('', () => this.emit('change'));
    });
  }

  /** Replace the process: `resume` continues the conversation, otherwise a new one starts. */
  private relaunch(resume: boolean) {
    const old = this.proc;
    this.proc = null;
    this.releasePermissions();
    old?.kill();
    this.resetMirror();
    this.spawn(resume);
    this.emit('reset');
    this.emit('change');
  }

  /** Continue the same Claude conversation, e.g. after a server restart. */
  resume(hasTranscript: boolean) {
    if (this.status === 'running') return;
    this.restart({ fresh: false, hasTranscript });
  }

  /**
   * Kill and relaunch claude. By default the conversation carries on; `fresh`
   * starts a new one. A session that never got a prompt has no transcript to resume.
   */
  restart({ fresh, hasTranscript }: { fresh: boolean; hasTranscript: boolean }) {
    if (fresh) {
      this.claudeSessionId = randomUUID();
      this.forgetConversation();
    }
    this.relaunch(!fresh && hasTranscript);
  }

  /** Relaunch with another model / effort, keeping the conversation. */
  configure(choices: LaunchChoices, hasTranscript: boolean) {
    this.modelChoice = choices.modelChoice;
    this.effortChoice = choices.effortChoice;
    this.model = null; // unknown until Claude reports it
    this.restart({ fresh: false, hasTranscript });
  }

  trackModel(model: string | null) {
    if (!model || model === this.model || this.status !== 'running') return;
    this.model = model;
    this.emit('change');
  }

  /** Claude switches conversations on /clear; follow it so resuming picks the current one. */
  trackClaudeSession(id: unknown) {
    if (typeof id !== 'string' || !id || id === this.claudeSessionId) return;
    this.claudeSessionId = id;
    this.forgetConversation();
    this.emit('change');
  }

  private forgetConversation() {
    this.usage = null;
    this.plan = [];
    this.turns = 0;
    this.summary = null;
  }

  /** Cost and context, reported by the status line relay. Not broadcast: the inspector asks for them. */
  trackStatusLine(payload: unknown) {
    this.usage = usageFromStatusLine(payload);
    // The status line first reports once the prompt is on screen.
    this.flushPending();
  }

  private pending: string | null = null;

  /** Types a prompt and submits it once Claude is ready for input. */
  sendWhenReady(text: string) {
    this.pending = text;
    // In case the status line never reports (e.g. replaced by the user's own settings).
    setTimeout(() => this.flushPending(), 15_000).unref();
  }

  private flushPending() {
    const text = this.pending;
    if (!text || !this.proc) return;
    this.pending = null;
    this.typeLine(text);
  }

  /** Types a line into Claude's prompt and submits it. */
  typeLine(text: string) {
    this.proc?.write(text);
    // Sent apart, or the Enter arrives inside the pasted text and makes a new line.
    setTimeout(() => this.proc?.write('\r'), 400);
  }

  /** Turns and plan, from the hooks. */
  trackHook(payload: any) {
    const event = payload?.hook_event_name;
    if (event === 'UserPromptSubmit') {
      this.turns++;
      this.summary = null;
      this.turnFiles.clear();
      this.cleanStop = false;
      this.draftLength = 0;
    }
    if (event === 'StopFailure') this.cleanStop = false;
    if (event === 'Stop') {
      this.cleanStop = true;
      this.scheduleSend();
    }
    if (event === 'PostToolUse' && EDIT_TOOLS.has(payload.tool_name)) {
      const file = payload.tool_input?.file_path ?? payload.tool_input?.notebook_path;
      if (typeof file === 'string') this.turnFiles.add(file);
    }
    if (event === 'Stop') {
      const text = summarize(payload.last_assistant_message);
      this.summary = text ? { text, files: this.turnFiles.size, at: Date.now() } : null;
    }
    if (event === 'PostToolUse' && payload.tool_name === 'Skill') {
      const input = payload.tool_input ?? {};
      const name = String(input.skill ?? input.command ?? input.name ?? '').replace(/^\//, '');
      if (name) this.lastSkill = { name, at: Date.now() };
    }
    const mcp = event === 'PostToolUse' && String(payload.tool_name ?? '').match(/^mcp__(.+?)__/);
    if (mcp) this.lastConnector = { toolPrefix: mcp[1], at: Date.now() };
    // The user answered Claude Code's own prompt: the call ran, or the turn moved on.
    if (event === 'PostToolUse') this.releasePermissions((p) => p.key === permissionKey(payload));
    if (event === 'UserPromptSubmit' || event === 'Stop' || event === 'StopFailure') this.releasePermissions();
    const plan = nextPlan(this.plan, payload);
    if (plan) this.plan = plan;
  }

  /** Keeps a PermissionRequest hook open until the user answers it here or in the terminal. */
  holdPermission(ask: PermissionAsk, always: PermissionRule[], payload: any, reply: HeldPermission['reply']): string {
    const id = randomUUID();
    this.held.push({ ...ask, id, key: permissionKey(payload), always, reply });
    this.emit('change');
    return id;
  }

  /**
   * Allow or deny from Orchia; `always` also saves the suggested allow rules.
   * False when the request was already answered elsewhere.
   */
  answerPermission(id: string, allow: boolean, always = false): boolean {
    const held = this.held.find((p) => p.id === id);
    if (!held) return false;
    this.held = this.held.filter((p) => p !== held);
    held.reply(allow, allow && always);
    if (!this.held.length) {
      // Denying stops the turn, and Claude Code fires no Stop hook for that.
      this.activity = allow ? 'working' : 'idle';
      this.detail = null;
      this.unseen = false;
    }
    this.emit('change');
    return true;
  }

  /** Lets the matching held requests go without a decision (all by default). */
  releasePermissions(which: (p: HeldPermission) => boolean = () => true) {
    const gone = this.held.filter(which);
    if (!gone.length) return;
    this.held = this.held.filter((p) => !gone.includes(p));
    for (const p of gone) p.reply(null);
    this.emit('change');
  }

  applyActivity({ activity, detail }: ActivityUpdate) {
    if (this.status !== 'running') return;
    // One question fires several hooks; keep the first, most specific reason.
    if (activity === 'waiting' && this.activity === 'waiting') return;
    const changed = activity !== this.activity || (detail ?? null) !== this.detail;
    this.activity = activity;
    this.detail = detail ?? null;
    // Finishing a turn or blocking on the user is worth a look; working is not.
    if (activity === 'waiting' || activity === 'idle') this.unseen = this.unseen || changed;
    if (changed) this.emit('change');
  }

  markSeen() {
    if (!this.unseen) return;
    this.unseen = false;
    this.emit('change');
  }

  rename(name: string) {
    this.name = name;
    this.emit('change');
  }

  write(data: string) {
    if (!this.proc) return;
    this.proc.write(data);
    this.trackTyping(data);
    // Enter answers the prompt on screen (the oldest request); Esc or Ctrl+C rejects them all.
    if (data.includes('\r')) this.releasePermissions((p) => p === this.held[0]);
    if (data === '\x1b' || data === '\x03') this.releasePermissions();
    // Answering a prompt in the terminal unblocks Claude before any hook says so.
    if (this.activity === 'waiting' && data.includes('\r')) this.applyActivity({ activity: 'working' });
    // Esc / Ctrl+C interrupt a turn, and Claude Code fires no Stop hook in that case.
    if (this.activity === 'working' && (data === '\x1b' || data === '\x03')) {
      this.activity = 'idle';
      this.detail = null;
      // Stopped on purpose: the queue waits for the user.
      this.cleanStop = false;
      this.emit('change');
    }
  }

  // ---- Up next ------------------------------------------------------------------

  /** Notes keystrokes, so the queue never types over a draft. Focus and mouse reports don't count. */
  private trackTyping(data: string) {
    if (/^\x1b\[(I|O|<[\d;]+[mM]|M...)$/.test(data)) return;
    this.lastInputAt = Date.now();
    // Enter sends the draft; Ctrl+C and Ctrl+U clear it. (A single Esc may not, so it doesn't count.)
    if (data.includes('\r') || data === '\x03' || data === '\x15') this.draftLength = 0;
    else if (data === '\x7f' || data === '\b') this.draftLength = Math.max(0, this.draftLength - 1);
    else if (!data.startsWith('\x1b')) this.draftLength += [...data].filter((c) => c >= ' ').length;
    // A draft held the queue back and is gone now: go once the user pauses.
    if (this.draftLength === 0 && this.cleanStop && this.queue.length) this.scheduleSend(TYPING_PAUSE_MS);
  }

  enqueue(text: string) {
    this.queue.push({ id: randomUUID(), text });
    this.emit('change');
    this.scheduleSend();
  }

  dequeue(id: string) {
    this.queue = this.queue.filter((q) => q.id !== id);
    this.emit('change');
  }

  /** New order, by id; ids not given keep their place at the end. */
  reorderQueue(ids: string[]) {
    const byId = new Map(this.queue.map((q) => [q.id, q]));
    const first = ids.map((id) => byId.get(id)).filter((q): q is QueuedPrompt => !!q);
    this.queue = [...first, ...this.queue.filter((q) => !first.includes(q))];
    this.emit('change');
  }

  /** "Send now": the user lifts the hold (stopped turn, or a draft they don't care about). */
  sendNextNow(): boolean {
    if (!this.canSend()) return false;
    this.sendNext();
    return true;
  }

  private queueHeld(): SessionInfo['queueHeld'] {
    if (!this.queue.length || !this.canSend()) return null;
    if (!this.cleanStop) return 'stopped';
    return this.draftLength > 0 ? 'typing' : null;
  }

  private canSend() {
    return this.status === 'running' && !!this.proc && this.activity === 'idle' && !this.held.length && this.queue.length > 0;
  }

  /** Sends the next prompt shortly after a clean Stop, once the user has not typed for a moment. */
  private scheduleSend(delay = 800) {
    if (this.sendTimer) clearTimeout(this.sendTimer);
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null;
      if (!this.canSend() || !this.cleanStop) return;
      if (this.draftLength > 0) return this.emit('change'); // Shows "waiting for your draft".
      const quiet = Date.now() - this.lastInputAt;
      if (quiet < TYPING_PAUSE_MS) return this.scheduleSend(TYPING_PAUSE_MS - quiet);
      this.sendNext();
    }, delay);
    this.sendTimer.unref();
  }

  private sendNext() {
    const next = this.queue.shift();
    if (!next) return;
    this.cleanStop = false;
    this.draftLength = 0;
    this.typeLine(next.text);
    // UserPromptSubmit confirms it; meanwhile nothing else may go.
    this.applyActivity({ activity: 'working' });
    this.emit('change');
  }

  resize(cols: number, rows: number) {
    if (cols < 2 || rows < 2 || (cols === this.cols && rows === this.rows)) return;
    this.cols = cols;
    this.rows = rows;
    this.mirror.resize(cols, rows);
    this.proc?.resize(cols, rows);
  }

  /** Current screen + scrollback as escape sequences, with the size they were laid out at. */
  snapshot(): { cols: number; rows: number; data: string } {
    return { cols: this.cols, rows: this.rows, data: this.serializer.serialize({ scrollback: SCROLLBACK }) };
  }

  dispose() {
    if (this.sendTimer) clearTimeout(this.sendTimer);
    this.releasePermissions();
    const proc = this.proc;
    this.proc = null;
    proc?.kill();
    this.mirror.dispose();
    this.removeAllListeners();
  }

  info(): SessionInfo {
    return {
      id: this.id,
      projectId: this.projectId,
      name: this.name,
      cwd: this.cwd,
      status: this.status,
      exitCode: this.exitCode,
      endedAt: this.endedAt,
      createdAt: this.createdAt,
      activity: this.activity,
      detail: this.detail,
      unseen: this.unseen,
      model: this.model,
      modelChoice: this.modelChoice,
      effortChoice: this.effortChoice,
      permissionMode: this.permissionMode,
      permission: this.held[0]
        ? {
            id: this.held[0].id,
            tool: this.held[0].tool,
            verb: this.held[0].verb,
            target: this.held[0].target,
            always: this.held[0].always.map(describeRule),
          }
        : null,
      summary: this.summary,
      queue: this.queue,
      queueHeld: this.queueHeld(),
      copy: this.copy,
    };
  }

  record(): SessionRecord {
    return {
      id: this.id,
      projectId: this.projectId,
      name: this.name,
      cwd: this.cwd,
      createdAt: this.createdAt,
      claudeSessionId: this.claudeSessionId,
      exited: this.status === 'exited',
      model: this.model,
      modelChoice: this.modelChoice,
      effortChoice: this.effortChoice,
      permissionMode: this.permissionMode,
      usage: this.usage,
      plan: this.plan,
      turns: this.turns,
      summary: this.summary,
      queue: this.queue,
      copy: this.copy,
    };
  }
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** The queue waits this long after the user's last keystroke. */
const TYPING_PAUSE_MS = 3000;

function permissionKey(payload: any): string {
  return JSON.stringify([payload?.tool_name, payload?.tool_input]);
}

// Markers set when the server itself is started from a Claude Code session or a
// VSCode terminal. Passing them down makes claude think it is a nested child
// session (e.g. transcripts disabled) or attached to an IDE it is not in.
const INHERITED_MARKERS = [
  /^CLAUDECODE$/,
  /^CLAUDE_CODE_(CHILD_SESSION|ENTRYPOINT|EXECPATH|MESSAGING_SOCKET|MESSAGING_TOKEN|SESSION_ATTENDED|SESSION_ID|SSE_PORT)$/,
  /^CLAUDE_(EFFORT|PID)$/,
  /^AI_AGENT$/,
  /^TERM_PROGRAM(_VERSION)?$/,
  /^VSCODE_/,
  /^GIT_ASKPASS$/,
];

export function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !INHERITED_MARKERS.some((re) => re.test(key))) env[key] = value;
  }
  return env;
}

function claudeCommand(hookSettings: string | null, extraArgs: string[]): [string, string[] | string] {
  const command = process.env.ORCHIA_CLAUDE ?? 'claude';
  const args = [...(hookSettings ? ['--settings', hookSettings] : []), ...extraArgs];
  if (process.platform === 'win32') {
    // `claude` is often an npm .cmd shim, which only cmd.exe can run. The command
    // line is passed pre-escaped: with /s, cmd strips the outer quotes and keeps
    // the inner ones. Our arguments are paths and UUIDs, which never contain quotes.
    const line = args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
    return [process.env.ComSpec ?? 'cmd.exe', `/d /s /c "${command} ${line}"`];
  }
  // ORCHIA_CLAUDE may hold arguments too (`node fake.js`): let the shell split it, as cmd does above.
  if (process.env.ORCHIA_CLAUDE) return ['/bin/sh', ['-c', `exec ${command} "$@"`, 'claude', ...args]];
  return [command, args];
}

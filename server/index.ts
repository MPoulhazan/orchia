import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { Session } from './session.ts';
import { CONFIG_DIR, ProjectStore, isCopyMode } from './projects.ts';
import { cloneRepo, cloneTarget } from './clone.ts';
import { MergeConflictError, canCopy, copyChanges, copyIsEmpty, createCopy, mergeCopy, removeCopy, resolvePrompt, type SessionCopy } from './copies.ts';
import { PERMISSION_WAIT_S, activityFromHook, permissionAsk, permissionDecision, writeHookSettings } from './hooks.ts';
import { projectAllowRules, removeAllowRule, suggestedRules } from './permissionRules.ts';
import { SessionStore, hasTranscript } from './sessionStore.ts';
import { SettingsStore } from './settings.ts';
import { CloudLink, type RemoteNeed } from './cloud.ts';
import { isEffortLevel, isModelAlias, watchModel, watchTitle } from './models.ts';
import { firstLotPlan, splitPlan } from './planLots.ts';
import { connectorNote, refreshAdvisories, skillNote } from './advisories.ts';
import type { LaunchChoices } from './session.ts';
import { claudeProjectSuggestions, homeFolder, listFolder } from './folders.ts';
import { gitSummary, limitsFromStatusLine, type RateLimits } from './inspector.ts';
import { MAX_PASTE_BYTES, isPasteType, savePaste, startPasteCleanup } from './pastes.ts';
import { importSkills, previewRepo } from './githubSkills.ts';
import { dropIssue, openIssues } from './githubIssues.ts';
import {
  addConnector,
  cachedConnectors,
  onConnectorsChecked,
  projectConnectors,
  removeConnector,
  serverConfig,
  setConnectorEnabled,
  setConnectorToken,
  signIn,
  signInsFor,
} from './mcp.ts';
import { catalogAlreadyThere, catalogConnectors } from './mcpCatalog.ts';
import { checkToken, cliToken, probeConnector, tokenHelp } from './mcpProbe.ts';
import { configFrom, type McpServerConfig } from './mcpSource.ts';
import { catalogSkills, suggestionsWithStars, suggestSkills } from './skillCatalog.ts';
import { copySkill,installPlugin, newSkillPrompt, pluginCatalog, projectSkills, setEnabled, skillsElsewhere } from './skills.ts';

const HOST = '127.0.0.1';
const PORT = Number(process.env.ORCHIA_PORT ?? 4317);
const DEV_WEB_PORT = 5173;
/** Share of the context window above which Orchia compacts before the next Up next prompt. */
const COMPACT_AT = 0.6;
const STATIC_DIR = fileURLToPath(new URL('../dist', import.meta.url));

const projects = new ProjectStore();
const hookSettings = writeHookSettings(CONFIG_DIR, PORT);
const sessions = new Map<string, Session>();
const sessionStore = new SessionStore(CONFIG_DIR);
const settings = new SettingsStore(CONFIG_DIR);
Session.compactAt = () => (settings.get().compactBetweenTasks ? COMPACT_AT : null);
startPasteCleanup();
const cloud = new CloudLink(CONFIG_DIR, { onChange: () => broadcast(), needs: remoteNeeds, answer: remoteAnswer });

// ---- Needs you on your phone (Orchia Cloud) ---------------------------------

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Running sessions that need you, cut to what Settings says is sent. */
function remoteNeeds(): RemoteNeed[] | null {
  if (!settings.get().remoteNeeds) return null;
  const projectNames = new Map(projects.list().map((p) => [p.id, p.name]));
  return [...sessions.values()].flatMap((s): RemoteNeed[] => {
    const info = s.info();
    if (info.status !== 'running') return [];
    const ask = info.permission;
    const kind = ask ? 'permission' : info.activity === 'waiting' ? 'waiting' : info.activity === 'idle' && info.summary && info.unseen ? 'done' : null;
    if (!kind) return [];
    return [
      {
        sessionId: info.id,
        session: clip(info.name, 80),
        project: clip(projectNames.get(info.projectId) ?? '', 80),
        kind,
        detail: info.detail ? clip(info.detail, 200) : null,
        permission: ask ? { id: ask.id, tool: clip(ask.tool, 80), verb: ask.verb, target: clip(ask.target, 300) } : null,
        summary: kind === 'done' ? clip(info.summary!.text, 600) : null,
      },
    ];
  });
}

/** An Allow or Deny from the phone, for the request it was shown: the oldest one of the session. */
function remoteAnswer(sessionId: string, permissionId: string, allow: boolean): string | null {
  const { remoteNeeds: on, remoteAnswers } = settings.get();
  if (!on) return 'Needs you on your phone is turned off in Orchia on this computer.';
  const session = sessions.get(sessionId);
  const ask = session?.info().permission;
  if (!session || ask?.id !== permissionId) return 'Already answered.';
  if (allow && remoteAnswers === 'deny-only') return 'Orchia on this computer only accepts Deny from your phone.';
  if (allow && remoteAnswers === 'no-shell' && SHELL_TOOLS.has(ask.tool)) return 'Orchia on this computer only lets you allow shell commands there.';
  // Never "Always allow" from afar: that would save a rule on this machine.
  return session.answerPermission(permissionId, allow, false) ? null : 'Already answered.';
}

// ---- Live state -------------------------------------------------------------
// Every client keeps one events socket open and receives the whole state on
// each change. The state is tiny, so this beats keeping diffs in sync.

const eventClients = new Set<WebSocket>();

/** Plan usage limits, as last reported by any session: they are shared by the whole account. */
let limits: RateLimits | null = null;

function state() {
  return {
    t: 'state',
    projects: projects.list(),
    sessions: [...sessions.values()].map((s) => s.info()),
    limits,
    settings: settings.get(),
    cloud: cloud.get(),
    signInNeeded: signInNeeded(),
    securityNeeded: securityNeeded(),
  };
}

/** The token to send to a connector: the one its service's CLI holds, or one pasted. Checked with the server first. */
async function tokenFrom(server: { type: 'http' | 'sse'; url: string }, body: any): Promise<string | null> {
  const token = body.useCli === true ? await cliToken(server.url) : typeof body.token === 'string' ? body.token.trim().replace(/^Bearer\s+/i, '') : '';
  if (body.useCli === true && !token) throw new Error('The CLI is not signed in any more. Paste a token instead.');
  if (!token) return null;
  if (!/^[\x21-\x7e]{8,4096}$/.test(token)) throw new Error("That doesn't look like a token");
  await checkToken(server.url, server.type, token);
  return token;
}

/** Connectors that wait for the user to sign in, in projects with a running session (the latest one, to open). */
function signInNeeded() {
  const latest = new Map<string, Session>();
  for (const s of sessions.values()) {
    if (s.status !== 'running') continue;
    const seen = latest.get(s.projectId);
    if (!seen || s.createdAt > seen.createdAt) latest.set(s.projectId, s);
  }
  // A connector of the account, the user or a plugin signs in once for every project: one row, not one per project.
  const sharedSeen = new Set<string>();
  return [...latest.values()].flatMap((s) => {
    const started = signInsFor(s.cwd);
    return cachedConnectors(s.cwd)
      .filter((c) => (c.state === 'needs-auth' || c.state === 'needs-token') && !c.duplicateOf)
      .filter((c) => {
        if (c.source === 'local' || c.source === 'project') return true;
        if (sharedSeen.has(c.name)) return false;
        sharedSeen.add(c.name);
        return true;
      })
      .map((c) => ({
        sessionId: s.id,
        projectId: s.projectId,
        name: c.name,
        label: c.label,
        shared: c.source !== 'local' && c.source !== 'project',
        needs: c.state === 'needs-token' ? 'token' : 'signin',
        signingIn: started[c.name]?.done === false,
        error: started[c.name]?.error ?? null,
      }));
  });
}

// A sign-in that is needed shows in "Needs you" as soon as a check finds it.
onConnectorsChecked(() => broadcast());

/**
 * Connectors with a high or critical advisory that applies for sure (the version in use is
 * affected, or there is no fix yet), for "Needs you". One row per connector and project.
 */
function securityNeeded() {
  const latest = new Map<string, Session>();
  for (const s of sessions.values()) {
    const seen = latest.get(s.projectId);
    if (!seen || s.createdAt > seen.createdAt) latest.set(s.projectId, s);
  }
  const shared = new Set<string>();
  return [...latest.values()].flatMap((s) =>
    cachedConnectors(s.cwd).flatMap((c) => {
      const note = connectorNote(c);
      if (!note || note.level === 'check' || (note.severity !== 'high' && note.severity !== 'critical')) return [];
      const isShared = c.source !== 'local' && c.source !== 'project';
      if (isShared && shared.has(c.name)) return [];
      shared.add(c.name);
      return [{ sessionId: s.id, projectId: s.projectId, name: c.name, label: c.label, shared: isShared, note }];
    }),
  );
}

// The catalog of advisories: at start, then once a day.
refreshAdvisories().then(broadcast);
setInterval(() => refreshAdvisories().then(broadcast), 60 * 60 * 1000).unref();

/** Push the new state to every client and persist the sessions. */
function broadcast() {
  const msg = JSON.stringify(state());
  for (const ws of eventClients) if (ws.readyState === ws.OPEN) ws.send(msg);
  sessionStore.save(() => [...sessions.values()].map((s) => s.record()));
  cloud.report();
}

function addSession(session: Session) {
  session.on('change', broadcast);
  session.on('change', restartQuietOnes);
  sessions.set(session.id, session);
}

/** Sessions to restart once quiet, so a connector change reaches them ("Restart by itself"). */
const restartWhenQuiet = new Set<Session>();

/** Connectors load when claude starts: every running session of the project needs a restart. */
function connectorsChanged(session: Session) {
  if (!settings.get().restartAfterConnectorChange) return;
  for (const s of sessions.values()) if (s.projectId === session.projectId && s.status === 'running') restartWhenQuiet.add(s);
  restartQuietOnes();
}

function restartQuietOnes() {
  for (const s of restartWhenQuiet) {
    if (s.status !== 'running') restartWhenQuiet.delete(s);
    else if (s.isQuiet()) {
      restartWhenQuiet.delete(s);
      s.restart({ fresh: false, hasTranscript: hasTranscript(s.claudeSessionId) });
    }
  }
}
// Typing pauses end without any event.
setInterval(restartQuietOnes, 5000).unref();

/** null (or missing) keeps Claude Code's default; anything else must be a known value. */
function parseChoices(body: any): LaunchChoices {
  const model = body.model ?? null;
  const effort = body.effort ?? null;
  if (model !== null && !isModelAlias(model)) throw new HttpError(400, 'Unknown model');
  if (effort !== null && !isEffortLevel(effort)) throw new HttpError(400, 'Unknown effort level');
  return { modelChoice: model, effortChoice: effort };
}

/** New sessions start from the settings; the request can override model and effort. */
function createSession(projectId: string, cols?: number, rows?: number, choices?: Partial<LaunchChoices>, copy?: { name: string; copy: SessionCopy }): Session {
  const project = projects.get(projectId);
  if (!project) throw new HttpError(404, 'Project not found');
  const defaults = settings.get();
  const session = new Session({
    projectId: project.id,
    cwd: project.path,
    name: copy?.name ?? nextSessionName(projectId),
    copy: copy?.copy,
    hookSettings,
    cols,
    rows,
    modelChoice: choices?.modelChoice ?? defaults.model,
    effortChoice: choices?.effortChoice ?? defaults.effort,
    permissionMode: defaults.permissionMode,
  });
  addSession(session);
  broadcast();
  projectConnectors(session.cwd).catch(() => {});
  return session;
}

function nextSessionName(projectId: string): string {
  const taken = new Set([...sessions.values()].filter((s) => s.projectId === projectId).map((s) => s.name));
  let n = 1;
  while (taken.has(`Session ${n}`)) n++;
  return `Session ${n}`;
}

/**
 * "+ New session": in the project folder, or in its own copy when another
 * session is already at work there. With the project's mode at "ask" (the
 * default), the answer is a question for the UI: `{ choose: { busy } }`.
 */
async function newSession(body: any) {
  const project = projects.get(String(body.projectId ?? ''));
  if (!project) throw new HttpError(404, 'Project not found');
  const where = body.where === 'copy' || body.where === 'same' ? body.where : null;
  if (where && body.remember === true) projects.setCopyMode(project.id, where);
  const busy = [...sessions.values()].filter((s) => s.projectId === project.id && !s.copy && s.status === 'running').map((s) => s.name);
  const mode = project.copyMode ?? 'ask';
  const copyable = where !== 'same' && mode !== 'same' && (where === 'copy' || mode === 'copy' || busy.length > 0) && (await canCopy(project.path));
  if (!where && copyable && mode === 'ask') return { choose: { busy } };
  const choices = parseChoices(body);
  if (!copyable) return createSession(project.id, body.cols, body.rows, choices).info();
  const name = nextSessionName(project.id);
  let copy: SessionCopy;
  try {
    copy = await createCopy(project.path, name);
  } catch (err) {
    throw new HttpError(500, `Could not make a copy of the project: ${(err as Error).message}`);
  }
  return createSession(project.id, body.cols, body.rows, choices, { name, copy }).info();
}

// Sessions from the previous run come back suspended; the UI resumes them when shown.
for (const record of sessionStore.load()) {
  const project = projects.get(record.projectId);
  if (!project) continue;
  addSession(new Session({ projectId: project.id, cwd: project.path, name: record.name, hookSettings, restore: record }));
}

function closeSession(session: Session) {
  session.dispose();
  sessions.delete(session.id);
  // An untouched copy goes with its session; one with work stays, branch and folder, for git.
  const copy = session.copy;
  const project = projects.get(session.projectId);
  if (copy && project) {
    copyIsEmpty(copy)
      .then((empty) => (empty ? removeCopy(project.path, copy) : undefined))
      .catch(() => {});
  }
}

/** The session and project of a copy, for the review routes. */
function copyOf(id: string) {
  const session = findSession(id);
  const project = projects.get(session.projectId);
  if (!session.copy || !project) throw new HttpError(400, 'This session does not work in its own copy');
  return { session, project, copy: session.copy };
}

const isBusy = (s: Session) => s.status === 'running' && (s.activity === 'working' || s.activity === 'waiting');

// ---- HTTP -------------------------------------------------------------------

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// The server spawns processes, so only accept requests coming from our own UI.
// Checking Host blocks DNS rebinding; checking Origin blocks cross-site requests.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const ALLOWED_PORTS = new Set([String(PORT), String(DEV_WEB_PORT)]);

function isTrusted(req: http.IncomingMessage): boolean {
  const host = req.headers.host ?? '';
  if (!LOCAL_HOSTS.has(host.replace(/:\d+$/, ''))) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return LOCAL_HOSTS.has(url.hostname) && ALLOWED_PORTS.has(url.port);
  } catch {
    return false;
  }
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Expected application/json');
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

/** A raw request body, refused past `max` bytes. */
async function readBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, `Too large (max ${Math.round(max / 1024 / 1024)} MB)`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function findSession(id: string): Session {
  const session = sessions.get(id);
  if (!session) throw new HttpError(404, 'Session not found');
  return session;
}

type Handler = (req: http.IncomingMessage, url: URL, params: string[]) => Promise<unknown> | unknown;

const routes: [string, RegExp, Handler][] = [
  ['GET', /^\/api\/state$/, () => state()],

  ['POST', /^\/api\/projects$/, async (req) => {
    const body = await readJson(req);
    try {
      const project = projects.add(String(body.path ?? ''));
      broadcast();
      return project;
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  }],
  ['GET', /^\/api\/projects\/clone$/, async (_req, url) => {
    try {
      return await cloneTarget(url.searchParams.get('url') ?? '', projects.list());
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  }],
  ['POST', /^\/api\/projects\/clone$/, async (req) => {
    const body = await readJson(req);
    // Closing the palette or the tab stops the clone.
    const stop = new AbortController();
    const onClose = () => stop.abort();
    req.socket.once('close', onClose);
    try {
      const project = projects.add(await cloneRepo(String(body.url ?? ''), projects.list(), stop.signal));
      broadcast();
      return project;
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    } finally {
      req.socket.off('close', onClose);
    }
  }],
  ['PATCH', /^\/api\/projects\/([\w-]+)$/, async (req, _url, [id]) => {
    const body = await readJson(req);
    if (!isCopyMode(body.copyMode)) throw new HttpError(400, 'Expected { copyMode: "ask" | "copy" | "same" }');
    try {
      projects.setCopyMode(id, body.copyMode);
    } catch (err) {
      throw new HttpError(404, (err as Error).message);
    }
    broadcast();
    return { ok: true };
  }],
  ['DELETE', /^\/api\/projects\/([\w-]+)$/, (_req, _url, [id]) => {
    for (const s of sessions.values()) if (s.projectId === id) closeSession(s);
    projects.remove(id);
    broadcast();
    return { ok: true };
  }],

  ['POST', /^\/api\/sessions$/, async (req) => {
    const body = await readJson(req);
    return newSession(body);
  }],

  ['PATCH', /^\/api\/settings$/, async (req) => {
    const body = await readJson(req);
    const patch: Record<string, unknown> = {};
    for (const key of ['model', 'effort', 'permissionMode', 'compactBetweenTasks', 'restartAfterConnectorChange', 'remoteNeeds', 'remoteAnswers']) if (key in body) patch[key] = body[key] ?? null;
    try {
      settings.update(patch);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    broadcast();
    return settings.get();
  }],
  ['POST', /^\/api\/cloud\/pair$/, async () => {
    try {
      return await cloud.pair();
    } catch (err) {
      throw new HttpError(502, (err as Error).message.startsWith('Orchia Cloud') ? (err as Error).message : 'Could not reach Orchia Cloud. Check your connection.');
    }
  }],
  ['POST', /^\/api\/cloud\/cancel$/, () => {
    cloud.cancelPairing();
    return cloud.get();
  }],
  ['DELETE', /^\/api\/cloud$/, async () => {
    await cloud.disconnect();
    return cloud.get();
  }],
  ['POST', /^\/api\/sessions\/([\w-]+)\/config$/, async (req, _url, [id]) => {
    const session = findSession(id);
    const choices = parseChoices(await readJson(req));
    // Relaunching mid-turn would cut Claude off; the UI only offers this when idle.
    if (session.status === 'running' && (session.activity === 'working' || session.activity === 'waiting')) {
      throw new HttpError(409, 'Claude is busy. Try again once it is idle.');
    }
    session.configure(choices, hasTranscript(session.claudeSessionId));
    return { ok: true };
  }],
  ['PATCH', /^\/api\/sessions\/([\w-]+)$/, async (req, _url, [id]) => {
    const body = await readJson(req);
    const name = String(body.name ?? '').trim().slice(0, 60);
    if (!name) throw new HttpError(400, 'Name is required');
    findSession(id).rename(name);
    return { ok: true };
  }],
  ['POST', /^\/api\/sessions\/([\w-]+)\/seen$/, (_req, _url, [id]) => {
    findSession(id).markSeen();
    return { ok: true };
  }],
  ['POST', /^\/api\/sessions\/([\w-]+)\/resume$/, (_req, _url, [id]) => {
    const session = findSession(id);
    session.resume(hasTranscript(session.claudeSessionId));
    projectConnectors(session.cwd).catch(() => {});
    return { ok: true };
  }],
  ['POST', /^\/api\/sessions\/([\w-]+)\/restart$/, async (req, _url, [id]) => {
    const session = findSession(id);
    const body = await readJson(req);
    session.restart({ fresh: body.fresh === true, hasTranscript: hasTranscript(session.claudeSessionId) });
    return { ok: true };
  }],
  // An image pasted or dropped on the terminal: saved for Claude Code, which gets its path.
  ['POST', /^\/api\/sessions\/([\w-]+)\/paste$/, async (req, _url, [id]) => {
    findSession(id);
    const type = String(req.headers['content-type'] ?? '');
    if (!isPasteType(type)) throw new HttpError(415, 'Only PNG, JPEG, GIF and WebP images can be pasted');
    return { path: savePaste(await readBody(req, MAX_PASTE_BYTES), type) };
  }],
  // Skills: per project, since Claude Code has no per-session skills (see skills.ts).
  ['GET', /^\/api\/sessions\/([\w-]+)\/skills$/, async (_req, _url, [id]) => {
    const session = findSession(id);
    const skills = await projectSkills(session.cwd);
    const dismissed = projects.get(session.projectId)?.dismissedSkills ?? [];
    return { skills: skills.map((s) => ({ ...s, security: skillNote(s) })), lastUsed: session.lastSkill, suggested: suggestSkills(session.cwd, skills, dismissed).length };
  }],
  ['GET', /^\/api\/sessions\/([\w-]+)\/skills\/available$/, async (_req, _url, [id]) => {
    const session = findSession(id);
    const have = await projectSkills(session.cwd);
    const installed = new Set(have.filter((s) => s.kind === 'plugin').map((s) => s.id.slice('plugin:'.length)));
    const dismissed = projects.get(session.projectId)?.dismissedSkills ?? [];
    const [plugins, suggested] = await Promise.all([
      pluginCatalog(session.cwd).catch(() => []),
      suggestionsWithStars(session.cwd, have, dismissed),
    ]);
    return {
      suggested,
      catalog: catalogSkills(have),
      elsewhere: skillsElsewhere(session.cwd, projects.list(), have),
      plugins: plugins.filter((p) => !installed.has(p.id)),
    };
  }],
  // The skills in a pasted GitHub link, before adding some.
  ['GET', /^\/api\/sessions\/([\w-]+)\/skills\/github$/, async (_req, url, [id]) => {
    const session = findSession(id);
    try {
      const [preview, have] = await Promise.all([previewRepo(url.searchParams.get('source') ?? ''), projectSkills(session.cwd)]);
      const names = new Set(have.filter((s) => s.kind === 'skill').map((s) => s.name));
      return { ...preview, skills: preview.skills.map((s) => ({ ...s, added: names.has(s.name) })) };
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  }],
  ['POST', /^\/api\/sessions\/([\w-]+)\/skills$/, async (req, _url, [id]) => {
    const session = findSession(id);
    const body = await readJson(req);
    const scope = body.scope === 'all' ? 'all' : 'project';
    try {
      switch (body.action) {
        case 'toggle':
          await setEnabled(session.cwd, String(body.id), body.on === true);
          return { ok: true, reload: String(body.id).startsWith('plugin:') };
        case 'copy':
          copySkill(session.cwd, String(body.path), scope);
          return { ok: true, reload: false };
        case 'import': {
          const names = Array.isArray(body.names) ? body.names.map(String) : [];
          await importSkills(session.cwd, String(body.source ?? ''), names, scope);
          return { ok: true, reload: false };
        }
        case 'install':
          await installPlugin(session.cwd, String(body.id), scope);
          return { ok: true, reload: true };
        case 'dismiss':
          projects.dismissSkill(session.projectId, String(body.name ?? ''));
          broadcast();
          return { ok: true };
        case 'reload':
          // Typed into the prompt, so only between turns.
          if (session.status !== 'running' || (session.activity !== 'idle' && session.activity !== 'starting')) throw new Error('Wait until Claude is idle');
          session.typeLine('/reload-plugins');
          return { ok: true };
        case 'create': {
          const description = String(body.description ?? '').trim();
          if (!description) throw new Error('Describe what the skill should do');
          const writer = createSession(session.projectId);
          writer.rename('New skill');
          writer.sendWhenReady(newSkillPrompt(session.cwd, description, scope));
          return { ok: true, sessionId: writer.id };
        }
      }
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    throw new HttpError(400, 'Unknown action');
  }],
  // Connectors (MCP servers): per project too, see mcp.ts. `fresh` waits for a new health check.
  ['GET', /^\/api\/sessions\/([\w-]+)\/connectors$/, async (_req, url, [id]) => {
    const session = findSession(id);
    const { connectors, checkedAt } = await projectConnectors(session.cwd, url.searchParams.has('fresh'));
    return { connectors: connectors.map((c) => ({ ...c, security: connectorNote(c) })), checkedAt, lastUsed: session.lastConnector, signIns: signInsFor(session.cwd) };
  }],
  ['GET', /^\/api\/sessions\/([\w-]+)\/connectors\/available$/, async (_req, _url, [id]) => {
    const session = findSession(id);
    const { connectors } = await projectConnectors(session.cwd);
    return { catalog: catalogConnectors(session.cwd, connectors), already: catalogAlreadyThere(connectors) };
  }],
  // How a server gets its access, before adding it: see mcpProbe.ts.
  ['POST', /^\/api\/sessions\/([\w-]+)\/connectors\/probe$/, async (req, _url, [id]) => {
    findSession(id);
    const server = configFrom((await readJson(req)).server);
    if (!server) throw new HttpError(400, 'Give a server URL or the command that starts it');
    return { auth: await probeConnector(server) };
  }],
  // Where to get a token for a connector that needs one.
  ['GET', /^\/api\/sessions\/([\w-]+)\/connectors\/token$/, async (_req, url, [id]) => {
    const server = serverConfig(findSession(id).cwd, url.searchParams.get('name') ?? '');
    if (!server || server.type === 'stdio') throw new HttpError(400, "This connector can't take a token from here");
    return { help: await tokenHelp(server.url) };
  }],
  ['POST', /^\/api\/sessions\/([\w-]+)\/connectors$/, async (req, _url, [id]) => {
    const session = findSession(id);
    const body = await readJson(req);
    try {
      if (body.action === 'signin') {
        signIn(session.cwd, String(body.name ?? ''), () => connectorsChanged(session));
        broadcast();
        return { ok: true };
      }
      if (body.action === 'toggle') {
        setConnectorEnabled(session.cwd, String(body.name ?? ''), body.on === true);
        connectorsChanged(session);
        return { ok: true };
      }
      if (body.action === 'add') {
        const server = configFrom(body.server);
        if (!server) throw new Error('Give a server URL or the command that starts it');
        const token = server.type === 'stdio' ? null : await tokenFrom(server, body);
        const added: McpServerConfig = token && server.type !== 'stdio' ? { ...server, headers: { ...server.headers, Authorization: `Bearer ${token}` } } : server;
        addConnector(session.cwd, String(body.name ?? '').trim(), added, body.scope === 'all' ? 'all' : 'project');
        connectorsChanged(session);
        return { ok: true };
      }
      if (body.action === 'token') {
        const name = String(body.name ?? '');
        const server = serverConfig(session.cwd, name);
        if (!server || server.type === 'stdio') throw new Error(`${name} can't take a token from here`);
        const token = await tokenFrom(server, body);
        if (!token) throw new Error('Paste a token');
        setConnectorToken(session.cwd, name, token);
        projectConnectors(session.cwd, true).catch(() => {});
        connectorsChanged(session);
        return { ok: true };
      }
      if (body.action === 'remove') {
        removeConnector(session.cwd, String(body.name ?? ''));
        connectorsChanged(session);
        return { ok: true };
      }
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    throw new HttpError(400, 'Unknown action');
  }],
  ['GET', /^\/api\/sessions\/([\w-]+)\/inspect$/, async (_req, _url, [id]) => {
    const session = findSession(id);
    return {
      usage: session.usage,
      plan: session.plan,
      turns: session.turns,
      blocks: session.blocks,
      git: await gitSummary(session.cwd),
      allowRules: projectAllowRules(session.cwd),
    };
  }],
  ['GET', /^\/api\/sessions\/([\w-]+)\/changes$/, async (_req, _url, [id]) => {
    const { project, copy } = copyOf(id);
    return copyChanges(project.path, copy);
  }],
  ['POST', /^\/api\/sessions\/([\w-]+)\/merge$/, async (_req, _url, [id]) => {
    const { session, project, copy } = copyOf(id);
    if (isBusy(session)) throw new HttpError(409, 'Claude is still working in this copy. Merge once it is done.');
    try {
      await mergeCopy(project.path, copy, session.name);
    } catch (err) {
      if (err instanceof MergeConflictError) return { ok: false, conflict: err.message };
      throw new HttpError(400, (err as Error).message);
    }
    session.dispose();
    sessions.delete(session.id);
    await removeCopy(project.path, copy).catch(() => {});
    broadcast();
    return { ok: true };
  }],
  ['POST', /^\/api\/sessions\/([\w-]+)\/discard$/, async (_req, _url, [id]) => {
    const { session, project, copy } = copyOf(id);
    session.dispose();
    sessions.delete(session.id);
    await removeCopy(project.path, copy);
    broadcast();
    return { ok: true };
  }],
  ['POST', /^\/api\/sessions\/([\w-]+)\/resolve$/, (_req, _url, [id]) => {
    const { session, copy } = copyOf(id);
    if (session.status !== 'running' || isBusy(session)) throw new HttpError(409, 'Wait until Claude is idle in this copy');
    session.typeLine(resolvePrompt(copy));
    return { ok: true };
  }],
  ['POST', /^\/api\/sessions\/([\w-]+)\/queue$/, async (req, _url, [id]) => {
    const body = await readJson(req);
    // One line: Claude Code would submit at the first line break.
    const text = typeof body.text === 'string' ? body.text.replace(/\s*\n\s*/g, ' ').trim() : '';
    if (!text) throw new HttpError(400, 'Expected { text }');
    findSession(id).enqueue(text);
    return { ok: true };
  }],
  ['GET', /^\/api\/sessions\/([\w-]+)\/issues$/, (_req, _url, [id]) => openIssues(findSession(id).cwd)],
  ['POST', /^\/api\/sessions\/([\w-]+)\/issues\/(\d+)\/close$/, async (_req, _url, [id, n]) => {
    const error = await dropIssue(findSession(id).cwd, Number(n), 'close');
    if (error) throw new HttpError(502, error);
    return { ok: true };
  }],
  ['DELETE', /^\/api\/sessions\/([\w-]+)\/issues\/(\d+)$/, async (_req, _url, [id, n]) => {
    const error = await dropIssue(findSession(id).cwd, Number(n), 'delete');
    if (error) throw new HttpError(502, error);
    return { ok: true };
  }],
  ['PUT', /^\/api\/sessions\/([\w-]+)\/queue$/, async (req, _url, [id]) => {
    const body = await readJson(req);
    if (!Array.isArray(body.ids)) throw new HttpError(400, 'Expected { ids }');
    findSession(id).reorderQueue(body.ids.map(String));
    return { ok: true };
  }],
  ['POST', /^\/api\/sessions\/([\w-]+)\/plan$/, async (req, _url, [id]) => {
    const body = await readJson(req);
    const lots = Array.isArray(body.lots) ? body.lots.map((l: unknown) => String(l).trim()).filter(Boolean) : [];
    if (!lots.length) throw new HttpError(400, 'Expected { lots }');
    if (!findSession(id).answerPlan(lots)) throw new HttpError(409, 'The plan was already answered');
    return { ok: true };
  }],
  ['POST', /^\/api\/sessions\/([\w-]+)\/run$/, async (req, _url, [id]) => {
    const body = await readJson(req);
    if (typeof body.command !== 'string') throw new HttpError(400, 'Expected { command }');
    const refused = findSession(id).runCommand(body.command);
    if (refused) throw new HttpError(409, refused);
    return { ok: true };
  }],
  ['POST', /^\/api\/sessions\/([\w-]+)\/queue\/send$/, (_req, _url, [id]) => {
    if (!findSession(id).sendNextNow()) throw new HttpError(409, 'Claude is busy');
    return { ok: true };
  }],
  ['DELETE', /^\/api\/sessions\/([\w-]+)\/queue\/([\w-]+)$/, (_req, _url, [id, queuedId]) => {
    findSession(id).dequeue(queuedId);
    return { ok: true };
  }],
  ['DELETE', /^\/api\/sessions\/([\w-]+)\/allow-rules$/, async (req, _url, [id]) => {
    const body = await readJson(req);
    if (typeof body.rule !== 'string') throw new HttpError(400, 'Expected { rule }');
    try {
      removeAllowRule(findSession(id).cwd, body.rule);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    return { ok: true };
  }],
  ['DELETE', /^\/api\/sessions\/([\w-]+)$/, (_req, _url, [id]) => {
    closeSession(findSession(id));
    broadcast();
    return { ok: true };
  }],

  ['POST', /^\/api\/sessions\/([\w-]+)\/permission$/, async (req, _url, [id]) => {
    const body = await readJson(req);
    if (typeof body.id !== 'string' || typeof body.allow !== 'boolean') throw new HttpError(400, 'Expected { id, allow, always? }');
    if (!findSession(id).answerPermission(body.id, body.allow, body.always === true)) throw new HttpError(409, 'Already answered');
    return { ok: true };
  }],

  ['GET', /^\/api\/suggestions$/, () => claudeProjectSuggestions()],
  ['GET', /^\/api\/folders$/, (_req, url) => {
    const path = url.searchParams.get('path');
    try {
      return listFolder(path === null ? homeFolder() : path || null);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  }],
];

/** The session a hook or the status line relay reports for, checked against its token. */
function reportingSession(req: http.IncomingMessage): Session | null {
  const session = sessions.get(String(req.headers['x-orchia-session'] ?? ''));
  const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
  return session && sameSecret(token, session.token) ? session : null;
}

/**
 * Called by Claude Code's HTTP hooks. Answers 204, which changes nothing, except
 * for permission requests: those stay open until the user allows or denies them
 * from Orchia, or answers in the terminal (then 204 too).
 */
async function handleHook(req: http.IncomingMessage, res: http.ServerResponse) {
  const session = reportingSession(req);
  if (!session) return sendJson(res, 403, { error: 'Forbidden' });
  const payload = await readJson(req);
  session.trackClaudeSession(payload?.session_id);
  session.trackHook(payload);
  watchModel(payload, (model) => session.trackModel(model));
  watchTitle(payload, (title) => session.trackTitle(title));
  const update = activityFromHook(payload);
  if (update) session.applyActivity(update);

  if (payload?.hook_event_name === 'PermissionRequest' && payload.tool_name === 'ExitPlanMode') return holdPlan(session, payload, res);
  const ask = payload?.hook_event_name === 'PermissionRequest' ? permissionAsk(payload, session.cwd) : null;
  if (!ask || session.status !== 'running') return res.writeHead(204).end();
  let timer: NodeJS.Timeout;
  const always = suggestedRules(payload);
  const id = session.holdPermission(ask, always, payload, (allow, saveRules) => {
    clearTimeout(timer);
    if (res.writableEnded || res.destroyed) return;
    if (allow === null) res.writeHead(204).end();
    else sendJson(res, 200, permissionDecision(allow, saveRules ? always : []));
  });
  // Give up shortly before Claude Code does, so it gets a clean answer.
  timer = setTimeout(() => session.releasePermissions((p) => p.id === id), (PERMISSION_WAIT_S - 5) * 1000);
  // Claude Code drops the request once its own prompt is answered.
  res.on('close', () => session.releasePermissions((p) => p.id === id));
}

/**
 * A plan to review that splits into lots stays open for "Split into Up next": the answer
 * approves it with lot 1 as the whole task (the other lots go to Up next). Approving or
 * rejecting it in the terminal instead closes the request, and Orchia lets go.
 */
function holdPlan(session: Session, payload: any, res: http.ServerResponse) {
  const plan = payload.tool_input?.plan;
  const lots = splitPlan(plan);
  if (!lots || session.status !== 'running') return res.writeHead(204).end();
  let timer: NodeJS.Timeout;
  const id = session.holdPlan(lots, (chosen) => {
    clearTimeout(timer);
    if (res.writableEnded || res.destroyed) return;
    if (!chosen) return res.writeHead(204).end();
    sendJson(res, 200, {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedInput: { ...payload.tool_input, plan: firstLotPlan(plan, chosen) } },
      },
    });
  });
  timer = setTimeout(() => session.releasePlan(id), (PERMISSION_WAIT_S - 5) * 1000);
  res.on('close', () => session.releasePlan(id));
}

/** Called by statusline.mjs each time Claude Code refreshes its status line. */
async function handleStatusLine(req: http.IncomingMessage, res: http.ServerResponse) {
  const session = reportingSession(req);
  if (!session) return sendJson(res, 403, { error: 'Forbidden' });
  const payload = await readJson(req);
  session.trackStatusLine(payload);
  res.writeHead(204).end();
  // The status line refreshes often; only tell clients when the numbers move.
  const next = limitsFromStatusLine(payload);
  if (next && JSON.stringify(next) !== JSON.stringify(limits)) {
    limits = next;
    broadcast();
  }
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  if (url.pathname === '/api/hook' && req.method === 'POST') return handleHook(req, res);
  if (url.pathname === '/api/statusline' && req.method === 'POST') return handleStatusLine(req, res);
  for (const [method, pattern, handler] of routes) {
    const match = url.pathname.match(pattern);
    if (match && req.method === method) return sendJson(res, 200, await handler(req, url, match.slice(1)));
  }
  throw new HttpError(404, 'Not found');
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(res: http.ServerResponse, path: string) {
  let file = normalize(join(STATIC_DIR, path));
  if (!file.startsWith(STATIC_DIR)) return sendJson(res, 403, { error: 'Forbidden' });
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(STATIC_DIR, 'index.html');
  if (!existsSync(file)) return sendJson(res, 404, { error: 'UI not built. Run `npm run dev` or `npm start`.' });
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);
  if (!isTrusted(req)) return sendJson(res, 403, { error: 'Forbidden' });
  try {
    await handleApi(req, res, url);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 400;
    sendJson(res, status, { error: (err as Error).message });
  }
});

// ---- WebSockets ---------------------------------------------------------------
// /api/events: server -> client {t:'state', projects, sessions}.
// /api/sessions/:id/stream:
//   client -> server {t:'in', d} keystrokes, {t:'resize', cols, rows}
//   server -> client {t:'snapshot', cols, rows, d} current screen on connect,
//                    {t:'out', d} output, {t:'reset'} before a restarted process.

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (!isTrusted(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  if (path === '/api/events') return wss.handleUpgrade(req, socket, head, attachEvents);

  const match = path.match(/^\/api\/sessions\/([\w-]+)\/stream$/);
  const session = match ? sessions.get(match[1]) : undefined;
  if (!session) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => attachStream(ws, session));
});

function attachEvents(ws: WebSocket) {
  eventClients.add(ws);
  ws.send(JSON.stringify(state()));
  ws.on('close', () => eventClients.delete(ws));
}

function attachStream(ws: WebSocket, session: Session) {
  const send = (msg: object) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

  const snap = session.snapshot();
  send({ t: 'snapshot', cols: snap.cols, rows: snap.rows, d: snap.data });

  const onData = (d: string) => send({ t: 'out', d });
  const onReset = () => send({ t: 'reset' });
  session.on('data', onData);
  session.on('reset', onReset);

  // With the session open in two windows, the PTY has one size: the window typed in
  // takes it back, or Claude draws past its edges (input box below the bottom).
  let size: { cols: number; rows: number } | null = null;
  ws.on('message', (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.t === 'in' && typeof msg.d === 'string') {
      if (size) session.resize(size.cols, size.rows);
      session.write(msg.d);
    }
    if (msg.t === 'resize') {
      size = { cols: Math.floor(msg.cols), rows: Math.floor(msg.rows) };
      session.resize(size.cols, size.rows);
    }
  });

  ws.on('close', () => {
    session.off('data', onData);
    session.off('reset', onReset);
  });
}

function shutdown() {
  // Save before killing: dying processes would otherwise be recorded as exited.
  sessionStore.save(() => [...sessions.values()].map((s) => s.record()));
  sessionStore.flush();
  for (const session of sessions.values()) session.dispose();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(
    `\nPort ${PORT} is already in use: another Orchia server is probably still running.\n` +
      `Stop it (close its terminal or press Ctrl+C there), then run npm start again.\n` +
      `To find it: netstat -ano | findstr :${PORT}\n`,
  );
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Orchia server on http://${HOST}:${PORT}`);
});

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { Session } from './session.ts';
import { CONFIG_DIR, ProjectStore } from './projects.ts';
import { PERMISSION_WAIT_S, activityFromHook, permissionAsk, permissionDecision, writeHookSettings } from './hooks.ts';
import { SessionStore, hasTranscript } from './sessionStore.ts';
import { SettingsStore } from './settings.ts';
import { isEffortLevel, isModelAlias, watchModel } from './models.ts';
import type { LaunchChoices } from './session.ts';
import { claudeProjectSuggestions, homeFolder, listFolder } from './folders.ts';
import { gitSummary, limitsFromStatusLine, type RateLimits } from './inspector.ts';
import { MAX_PASTE_BYTES, isPasteType, savePaste, startPasteCleanup } from './pastes.ts';
import { importSkills, previewRepo } from './githubSkills.ts';
import { catalogSkills, suggestionsWithStars, suggestSkills } from './skillCatalog.ts';
import { copySkill,installPlugin, newSkillPrompt, pluginCatalog, projectSkills, setEnabled, skillsElsewhere } from './skills.ts';

const HOST = '127.0.0.1';
const PORT = Number(process.env.AGENTHUB_PORT ?? 4317);
const DEV_WEB_PORT = 5173;
const STATIC_DIR = fileURLToPath(new URL('../dist', import.meta.url));

const projects = new ProjectStore();
const hookSettings = writeHookSettings(CONFIG_DIR, PORT);
const sessions = new Map<string, Session>();
const sessionStore = new SessionStore(CONFIG_DIR);
const settings = new SettingsStore(CONFIG_DIR);
startPasteCleanup();

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
  };
}

/** Push the new state to every client and persist the sessions. */
function broadcast() {
  const msg = JSON.stringify(state());
  for (const ws of eventClients) if (ws.readyState === ws.OPEN) ws.send(msg);
  sessionStore.save(() => [...sessions.values()].map((s) => s.record()));
}

function addSession(session: Session) {
  session.on('change', broadcast);
  sessions.set(session.id, session);
}

/** null (or missing) keeps Claude Code's default; anything else must be a known value. */
function parseChoices(body: any): LaunchChoices {
  const model = body.model ?? null;
  const effort = body.effort ?? null;
  if (model !== null && !isModelAlias(model)) throw new HttpError(400, 'Unknown model');
  if (effort !== null && !isEffortLevel(effort)) throw new HttpError(400, 'Unknown effort level');
  return { modelChoice: model, effortChoice: effort };
}

/** New sessions start from the settings; the request can override model and effort. */
function createSession(projectId: string, cols?: number, rows?: number, choices?: Partial<LaunchChoices>): Session {
  const project = projects.get(projectId);
  if (!project) throw new HttpError(404, 'Project not found');
  const taken = new Set([...sessions.values()].filter((s) => s.projectId === projectId).map((s) => s.name));
  let n = 1;
  while (taken.has(`Session ${n}`)) n++;
  const defaults = settings.get();
  const session = new Session({
    projectId: project.id,
    cwd: project.path,
    name: `Session ${n}`,
    hookSettings,
    cols,
    rows,
    modelChoice: choices?.modelChoice ?? defaults.model,
    effortChoice: choices?.effortChoice ?? defaults.effort,
    permissionMode: defaults.permissionMode,
  });
  addSession(session);
  broadcast();
  return session;
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
}

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
  ['DELETE', /^\/api\/projects\/([\w-]+)$/, (_req, _url, [id]) => {
    for (const s of sessions.values()) if (s.projectId === id) closeSession(s);
    projects.remove(id);
    broadcast();
    return { ok: true };
  }],

  ['POST', /^\/api\/sessions$/, async (req) => {
    const body = await readJson(req);
    return createSession(String(body.projectId ?? ''), body.cols, body.rows, parseChoices(body)).info();
  }],

  ['PATCH', /^\/api\/settings$/, async (req) => {
    const body = await readJson(req);
    const patch: Record<string, unknown> = {};
    for (const key of ['model', 'effort', 'permissionMode']) if (key in body) patch[key] = body[key] ?? null;
    try {
      settings.update(patch);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    broadcast();
    return settings.get();
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
    return { skills, lastUsed: session.lastSkill, suggested: suggestSkills(session.cwd, skills, dismissed).length };
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
  ['GET', /^\/api\/sessions\/([\w-]+)\/inspect$/, async (_req, _url, [id]) => {
    const session = findSession(id);
    return { usage: session.usage, plan: session.plan, turns: session.turns, git: await gitSummary(session.cwd) };
  }],
  ['DELETE', /^\/api\/sessions\/([\w-]+)$/, (_req, _url, [id]) => {
    closeSession(findSession(id));
    broadcast();
    return { ok: true };
  }],

  ['POST', /^\/api\/sessions\/([\w-]+)\/permission$/, async (req, _url, [id]) => {
    const body = await readJson(req);
    if (typeof body.id !== 'string' || typeof body.allow !== 'boolean') throw new HttpError(400, 'Expected { id, allow }');
    if (!findSession(id).answerPermission(body.id, body.allow)) throw new HttpError(409, 'Already answered');
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
  const session = sessions.get(String(req.headers['x-agenthub-session'] ?? ''));
  const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
  return session && sameSecret(token, session.token) ? session : null;
}

/**
 * Called by Claude Code's HTTP hooks. Answers 204, which changes nothing, except
 * for permission requests: those stay open until the user allows or denies them
 * from AgentHub, or answers in the terminal (then 204 too).
 */
async function handleHook(req: http.IncomingMessage, res: http.ServerResponse) {
  const session = reportingSession(req);
  if (!session) return sendJson(res, 403, { error: 'Forbidden' });
  const payload = await readJson(req);
  session.trackClaudeSession(payload?.session_id);
  session.trackHook(payload);
  watchModel(payload, (model) => session.trackModel(model));
  const update = activityFromHook(payload);
  if (update) session.applyActivity(update);

  const ask = payload?.hook_event_name === 'PermissionRequest' ? permissionAsk(payload, session.cwd) : null;
  if (!ask || session.status !== 'running') return res.writeHead(204).end();
  let timer: NodeJS.Timeout;
  const id = session.holdPermission(ask, payload, (allow) => {
    clearTimeout(timer);
    if (res.writableEnded || res.destroyed) return;
    if (allow === null) res.writeHead(204).end();
    else sendJson(res, 200, permissionDecision(allow));
  });
  // Give up shortly before Claude Code does, so it gets a clean answer.
  timer = setTimeout(() => session.releasePermissions((p) => p.id === id), (PERMISSION_WAIT_S - 5) * 1000);
  // Claude Code drops the request once its own prompt is answered.
  res.on('close', () => session.releasePermissions((p) => p.id === id));
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

  ws.on('message', (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.t === 'in' && typeof msg.d === 'string') session.write(msg.d);
    if (msg.t === 'resize') session.resize(Math.floor(msg.cols), Math.floor(msg.rows));
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
    `\nPort ${PORT} is already in use: another AgentHub server is probably still running.\n` +
      `Stop it (close its terminal or press Ctrl+C there), then run npm start again.\n` +
      `To find it: netstat -ano | findstr :${PORT}\n`,
  );
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`AgentHub server on http://${HOST}:${PORT}`);
});

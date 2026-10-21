// End-to-end check of a built Orchia: starts the server with a fake `claude`, opens a
// session and walks it through a turn (working, permission, allow, done, status line).
//
// Usage: node scripts/smoke.mjs [path/to/bin/orchia.mjs]
// Defaults to this repo's bin; CI passes the one installed from the packed tarball.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BIN = resolve(process.argv[2] ?? new URL('../bin/orchia.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const PORT = 4396;
const BASE = `http://127.0.0.1:${PORT}`;
// Forward slashes: the fake's path ends up in a cmd.exe command line on Windows.
const dir = mkdtempSync(join(tmpdir(), 'orchia-smoke-')).replace(/\\/g, '/');
const home = `${dir}/home`;
const project = `${dir}/project`;
const fake = `${dir}/fakeclaude.cjs`;
const result = `${dir}/fake-result.json`;
mkdirSync(project);

writeFileSync(fake, `
const { execSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const settings = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--settings') + 1], 'utf8'));
const out = {};
const hook = (payload) => fetch(settings.hooks.Stop[0].hooks[0].url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-orchia-session': process.env.ORCHIA_SESSION_ID, authorization: 'Bearer ' + process.env.ORCHIA_TOKEN },
  body: JSON.stringify({ session_id: 'smoke-session', cwd: process.cwd(), ...payload }),
});
(async () => {
  process.stdout.write('Fake Claude ready\\r\\n');
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'run the tests' });
  execSync(settings.statusLine.command, { input: JSON.stringify({ session_id: 'smoke-session', cost: { total_cost_usd: 0.4242 } }) });
  out.statusLine = 'ok';
  const answer = await hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  out.permission = answer.status === 200 ? await answer.json() : answer.status;
  await hook({ hook_event_name: 'Stop', last_assistant_message: 'All tests pass.' });
  writeFileSync(${JSON.stringify(result)}, JSON.stringify(out));
  process.stdout.write('Fake Claude done\\r\\n');
  setInterval(() => {}, 1000);
})().catch((err) => { writeFileSync(${JSON.stringify(result)}, JSON.stringify({ error: String(err) })); });
`);

const server = spawn(process.execPath, [BIN], {
  env: { ...process.env, ORCHIA_PORT: String(PORT), ORCHIA_HOME: home, ORCHIA_CLAUDE: `node ${fake}` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));

const api = async (method, path, body) => {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.headers.get('content-type')?.includes('json') ? res.json() : res.text();
};

async function until(what, check, timeout = 20000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const session = async (id) => (await api('GET', '/api/state')).sessions.find((s) => s.id === id);

function step(name) {
  console.log(`ok  ${name}`);
}

try {
  await until('the server', () => api('GET', '/api/state'));
  step('server starts');

  const page = await api('GET', '/');
  if (!page.includes('<title>Orchia</title>')) throw new Error('The UI page is not served');
  const script = page.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  if (!script || !(await api('GET', script)).length) throw new Error('The UI script is not served');
  step('serves the UI');

  const { id: projectId } = await api('POST', '/api/projects', { path: project });
  const { id } = await api('POST', '/api/sessions', { projectId, cols: 100, rows: 30 });
  step('creates a session');

  const asking = await until('the permission request', async () => {
    const s = await session(id);
    return s?.activity === 'waiting' && s.permission ? s : null;
  });
  if (asking.permission.target !== 'npm test') throw new Error(`Unexpected permission: ${JSON.stringify(asking.permission)}`);
  step('shows the permission request');

  await api('POST', `/api/sessions/${id}/permission`, { id: asking.permission.id, allow: true });
  await until('the end of the turn', async () => (await session(id))?.activity === 'idle');
  const out = await until('the fake claude', async () => existsSync(result) && JSON.parse(readFileSync(result, 'utf8')));
  if (out.error) throw new Error(`Fake claude failed: ${out.error}`);
  if (out.permission?.hookSpecificOutput?.decision?.behavior !== 'allow') throw new Error(`Claude did not get an allow: ${JSON.stringify(out.permission)}`);
  step('allow reaches Claude, turn ends');

  const done = await session(id);
  if (!done.summary) throw new Error('No done summary');
  const inspect = JSON.stringify(await api('GET', `/api/sessions/${id}/inspect`));
  if (!inspect.includes('0.4242')) throw new Error(`Status line numbers missing: ${inspect}`);
  step('done summary and status line');

  console.log('\nSmoke test passed');
} catch (err) {
  const state = await api('GET', '/api/state').catch(() => null);
  const fakeOut = existsSync(result) ? readFileSync(result, 'utf8') : '(none)';
  console.error(`\nSmoke test FAILED: ${err.message}\n\nSessions: ${JSON.stringify(state?.sessions, null, 2)}\nFake claude result: ${fakeOut}\n\nServer output:\n${log}`);
  process.exitCode = 1;
} finally {
  server.kill();
  setTimeout(() => process.exit(), 500).unref();
}

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
const transcript = `${dir}/transcript.jsonl`;
const typedFile = `${dir}/typed.txt`;
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
  writeFileSync(${JSON.stringify(transcript)}, JSON.stringify({ type: 'ai-title', aiTitle: 'Fix the "flaky" tests', sessionId: 'smoke-session' }) + '\\n');
  const reply = ['All tests pass. Run them again with:', '', '\\x60\\x60\\x60bash', 'npm test', '\\x60\\x60\\x60'].join('\\n');
  await hook({ hook_event_name: 'Stop', last_assistant_message: reply, transcript_path: ${JSON.stringify(transcript)} });
  writeFileSync(${JSON.stringify(result)}, JSON.stringify(out));
  process.stdout.write('Fake Claude done\\r\\n');
  // What Orchia types into the prompt, for the Run check.
  let typed = '';
  // Raw, like Claude Code: on macOS and Linux the terminal would otherwise turn Enter into \\n and wait for it.
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  let planned = false;
  let compacted = false;
  let lot2 = false;
  process.stdin.on('data', async (d) => {
    writeFileSync(${JSON.stringify(typedFile)}, (typed += d));
    if (planned && !compacted && typed.includes('/compact\\r')) {
      // Orchia compacts before sending lot 2.
      compacted = true;
      await hook({ hook_event_name: 'PreCompact', trigger: 'manual' });
      await hook({ hook_event_name: 'PostCompact', trigger: 'manual' });
      return;
    }
    if (compacted && !lot2 && /Continue the plan with lot 2[^\\r]*\\r/.test(typed)) {
      // Lot 2 fails: Orchia should hold lot 3.
      lot2 = true;
      await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'lot 2' });
      await hook({ hook_event_name: 'Stop', last_assistant_message: 'Two tests fail.\\n\\nLOT 2 BLOCKED: tests fail' });
      return;
    }
    if (planned || !typed.includes('\\r')) return;
    // The next turn: a plan in two steps, held for "Split into Up next".
    planned = true;
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: typed });
    const plan = ['# Plan', '', '## Steps', '1. Add the parser.', '2. Wire the queue.', '3. Show the lots.'].join('\\n');
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { plan } });
    const approval = await hook({ hook_event_name: 'PermissionRequest', tool_name: 'ExitPlanMode', tool_input: { plan } });
    out.plan = approval.status === 200 ? await approval.json() : approval.status;
    writeFileSync(${JSON.stringify(result)}, JSON.stringify(out));
    // Lot 1 done, with the context 70% full: Orchia should compact before lot 2.
    const context = { context_window_size: 200000, current_usage: { input_tokens: 140000 } };
    execSync(settings.statusLine.command, { input: JSON.stringify({ session_id: 'smoke-session', context_window: context }) });
    await hook({ hook_event_name: 'Stop', last_assistant_message: 'Parser added.\\n\\nLOT 1 DONE' });
  });
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

  if (asking.name !== 'run the tests') throw new Error(`Not named from the first prompt: ${asking.name}`);
  await until("Claude's title as the name", async () => (await session(id))?.name === 'Fix the "flaky" tests');
  step('names the session from the conversation');

  const { blocks } = await api('GET', `/api/sessions/${id}/inspect`);
  if (blocks?.length !== 1 || blocks[0].command !== 'npm test') throw new Error(`Unexpected code blocks: ${JSON.stringify(blocks)}`);
  await api('POST', `/api/sessions/${id}/run`, { command: 'npm test' });
  await until('the command typed in the prompt', async () => existsSync(typedFile) && readFileSync(typedFile, "utf8").startsWith("!npm test\r"), 5000);
  step('lists code blocks, Run types the command');

  const planning = await until('the plan lots', async () => (await session(id))?.planLots);
  if (planning.length !== 3) throw new Error(`Unexpected lots: ${JSON.stringify(planning)}`);
  await api('POST', `/api/sessions/${id}/plan`, { lots: planning });
  const approved = await until("Claude's plan answer", async () => JSON.parse(readFileSync(result, 'utf8')).plan);
  const firstLot = approved?.hookSpecificOutput?.decision?.updatedInput?.plan ?? '';
  if (!firstLot.includes('Do lot 1 only') || !firstLot.includes('1. Add the parser.') || !firstLot.includes('"LOT 1 DONE"')) throw new Error(`Unexpected approval: ${JSON.stringify(approved)}`);
  const queued = (await session(id)).queue.map((q) => q.text);
  if (queued.length !== 2 || !queued[0].includes('lot 2 of 3') || !queued[0].includes('Wire the queue')) throw new Error(`Unexpected queue: ${JSON.stringify(queued)}`);
  step('splits a plan: lot 1 approved, lot 2 in Up next');

  const typedAll = await until('lot 2 sent after a /compact', async () => {
    const typed = existsSync(typedFile) ? readFileSync(typedFile, 'utf8') : '';
    return typed.includes('Continue the plan with lot 2') ? typed : null;
  }, 15000);
  const compactAt = typedAll.indexOf('/compact');
  if (compactAt < 0 || compactAt > typedAll.indexOf('Continue the plan with lot 2')) throw new Error(`No /compact before lot 2: ${JSON.stringify(typedAll)}`);
  step('compacts a full context before the next lot');

  const blocked = await until('lot 2 blocked', async () => (await session(id))?.lotBlocked);
  if (blocked.n !== 2 || blocked.reason !== 'tests fail') throw new Error(`Unexpected block: ${JSON.stringify(blocked)}`);
  await new Promise((r) => setTimeout(r, 2500));
  if (readFileSync(typedFile, 'utf8').includes('Continue the plan with lot 3')) throw new Error('Lot 3 went although lot 2 was blocked');
  step('holds the next lots when one is blocked');

  await api('POST', `/api/sessions/${id}/queue/send`);
  await until('lot 3 sent on Resume', async () => readFileSync(typedFile, 'utf8').includes('Continue the plan with lot 3'), 5000);
  if ((await session(id)).lotBlocked) throw new Error('Still blocked after Resume');
  step('Resume sends the next lot');

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

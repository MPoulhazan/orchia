// End-to-end check of a built Orchia: starts the server with a fake `claude`, opens a
// session and walks it through a turn (working, permission, allow, done, status line).
//
// Usage: node scripts/smoke.mjs [path/to/bin/orchia.mjs]
// Defaults to this repo's bin; CI passes the one installed from the packed tarball.

import { execFileSync, spawn } from 'node:child_process';
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
  let lot3 = false;
  let answered = false;
  let answerLot1 = false;
  let cleared = false;
  let clearedLot2 = false;
  let lotsAsked = false;
  let committed = false;
  let envShown = false;
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
    if (lot2 && !lot3 && /Continue the plan with lot 3[^\\r]*\\r/.test(typed)) {
      lot3 = true;
      await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'lot 3' });
      await hook({ hook_event_name: 'Stop', last_assistant_message: 'Lots shown.\\n\\nLOT 3 DONE' });
      return;
    }
    if (lot3 && !answered && /Plan the export[^\\r]*\\r/.test(typed)) {
      // An ordinary answer in lots, outside plan mode: offered as "Run as a sequence".
      answered = true;
      await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Plan the export' });
      const answer = ['Here is the plan.', '', '**Lot 1: CSV writer**', 'Write rows.', '', '**Lot 2: Download button**', 'Wire it.'].join('\\n');
      await hook({ hook_event_name: 'Stop', last_assistant_message: answer });
      return;
    }
    if (answered && !answerLot1 && /Continue the plan with lot 1 of 2[^\\r]*\\r/.test(typed)) {
      answerLot1 = true;
      await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'answer lot 1' });
      await hook({ hook_event_name: 'Stop', last_assistant_message: 'CSV writer done.\\n\\nLOT 1 DONE' });
      return;
    }
    if (answerLot1 && !cleared && typed.endsWith('/clear\\r')) {
      // Clear mode: Claude Code starts a new conversation, then Orchia sends lot 2.
      cleared = true;
      await hook({ hook_event_name: 'SessionStart', source: 'clear' });
      return;
    }
    if (cleared && !clearedLot2 && /You are running a plan in 2 lots[^\\r]*\\r/.test(typed)) {
      clearedLot2 = true;
      await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'answer lot 2' });
      await hook({ hook_event_name: 'Stop', last_assistant_message: 'Button wired.\\n\\nLOT 2 DONE' });
      return;
    }
    if (clearedLot2 && !lotsAsked && typed.endsWith('/lots\\r')) {
      // /lots: Claude restates its last plan with "### Lot N:" headings.
      lotsAsked = true;
      await hook({ hook_event_name: 'UserPromptSubmit', prompt: '/lots' });
      await hook({ hook_event_name: 'Stop', last_assistant_message: '### Lot 1: Tokens\\nMove colors.\\n\\n### Lot 2: Toggle\\nAdd the button.' });
      return;
    }
    if (lotsAsked && !committed && typed.endsWith('Commit the config\\r')) {
      // Claude is about to commit a staged AWS key: Orchia should refuse the command.
      committed = true;
      await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Commit the config' });
      const guard = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git add -A && git commit -m "config"' } });
      out.guard = guard.status === 200 ? await guard.json() : guard.status;
      writeFileSync(${JSON.stringify(result)}, JSON.stringify(out));
      await hook({ hook_event_name: 'Stop', last_assistant_message: 'The commit was refused.' });
      return;
    }
    if (committed && !envShown && typed.endsWith('Show the env\\r')) {
      // The project blocks .env reads: printing one from the shell is refused too.
      envShown = true;
      await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Show the env' });
      const shown = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cat api/.env.local | head' } });
      out.envGuard = shown.status === 200 ? await shown.json() : shown.status;
      const loaded = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'source .env && npm run migrate' } });
      out.envLoad = loaded.status;
      writeFileSync(${JSON.stringify(result)}, JSON.stringify(out));
      await hook({ hook_event_name: 'Stop', last_assistant_message: 'Reading it was refused.' });
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
  const heldRun = (await session(id)).lotRun;
  if (heldRun?.state !== 'blocked' || heldRun.n !== 2 || heldRun.total !== 3) throw new Error(`Unexpected run while blocked: ${JSON.stringify(heldRun)}`);
  await new Promise((r) => setTimeout(r, 2500));
  if (readFileSync(typedFile, 'utf8').includes('Continue the plan with lot 3')) throw new Error('Lot 3 went although lot 2 was blocked');
  step('holds the next lots when one is blocked');

  await api('POST', `/api/sessions/${id}/queue/send`);
  await until('lot 3 sent on Resume', async () => readFileSync(typedFile, 'utf8').includes('Continue the plan with lot 3'), 5000);
  if ((await session(id)).lotBlocked) throw new Error('Still blocked after Resume');
  step('Resume sends the next lot');

  const doneRun = await until('the run of lots done', async () => {
    const run = (await session(id))?.lotRun;
    return run?.state === 'done' ? run : null;
  });
  if (doneRun.n !== 3 || doneRun.total !== 3) throw new Error(`Unexpected finished run: ${JSON.stringify(doneRun)}`);
  step('reports the run of lots as done after the last one');

  await api('POST', `/api/sessions/${id}/queue`, { text: 'Plan the export' });
  const answerLots = await until('the lots of an ordinary answer', async () => (await session(id))?.answerLots);
  if (answerLots.length !== 2 || !answerLots[1].includes('Download button')) throw new Error(`Unexpected answer lots: ${JSON.stringify(answerLots)}`);
  await api('POST', `/api/sessions/${id}/plan`, { lots: answerLots, between: 'clear' });
  await until('lot 1 of the answer typed', async () => readFileSync(typedFile, 'utf8').includes('Continue the plan with lot 1 of 2 only, then stop: Lot 1: CSV writer'), 5000);
  if ((await session(id)).answerLots) throw new Error('The answer lots are still offered after Run as a sequence');
  step('runs an ordinary answer in lots as a sequence');

  const afterClear = await until('lot 2 sent after a /clear', async () => {
    const typed = readFileSync(typedFile, 'utf8');
    return typed.includes('Lot 1 is done and committed') ? typed : null;
  }, 10000);
  const lot1At = afterClear.indexOf('Continue the plan with lot 1 of 2');
  const clearAt = afterClear.indexOf('/clear', lot1At);
  const lot2At = afterClear.indexOf('Lot 1 is done and committed');
  if (clearAt < 0 || clearAt > lot2At) throw new Error(`No /clear between the lots: ${JSON.stringify(afterClear.slice(lot1At))}`);
  if (!afterClear.slice(lot2At).includes('The whole plan: Lot 1: CSV writer')) throw new Error('The lot after /clear lacks the whole plan');
  step('clears between lots, with the whole plan in the next prompt');

  await until('the cleared run done', async () => (await session(id))?.lotRun?.state === 'done');
  await api('POST', `/api/sessions/${id}/queue`, { text: '/lots' });
  const asked = await until('the lots of /lots, editor open', async () => {
    const s = await session(id);
    return s?.answerLotsAsked ? s.answerLots : null;
  });
  if (asked.length !== 2 || !asked[1].startsWith('### Lot 2: Toggle')) throw new Error(`Unexpected /lots answer: ${JSON.stringify(asked)}`);
  step('/lots restates the plan as lots and opens the editor');

  const git = (args) => execFileSync('git', args, { cwd: project, stdio: 'ignore' });
  git(['init', '-q']);
  writeFileSync(`${project}/config.ts`, 'export const key = "AKIAIOSFODNN7EXAMPLE";\n');
  await api('POST', `/api/sessions/${id}/queue`, { text: 'Commit the config' });
  const guard = await until('the commit guard answer', async () => JSON.parse(readFileSync(result, 'utf8')).guard);
  const decision = guard?.hookSpecificOutput;
  if (decision?.permissionDecision !== 'deny' || !decision.permissionDecisionReason.includes('AWS access key (AKIA…MPLE) in config.ts')) {
    throw new Error(`Unexpected guard answer: ${JSON.stringify(guard)}`);
  }
  if (decision.permissionDecisionReason.includes('AKIAIOSFODNN7EXAMPLE')) throw new Error('The reason shows the whole key');
  const exposed = (await api('GET', '/api/state')).secretsExposed ?? [];
  if (!exposed.some((e) => e.source === 'commit' && e.where?.includes('config.ts'))) throw new Error(`No commit alert: ${JSON.stringify(exposed)}`);
  step('refuses a git commit that adds a secret, and raises the alert');

  mkdirSync(`${project}/.claude`, { recursive: true });
  writeFileSync(`${project}/.claude/settings.local.json`, JSON.stringify({ permissions: { deny: ['Read(**/.env)', 'Read(**/.env.*)'] } }));
  await api('POST', `/api/sessions/${id}/queue`, { text: 'Show the env' });
  const envGuard = await until('the .env read guard answer', async () => JSON.parse(readFileSync(result, 'utf8')).envGuard);
  if (envGuard?.hookSpecificOutput?.permissionDecision !== 'deny' || !envGuard.hookSpecificOutput.permissionDecisionReason.includes('api/.env.local')) {
    throw new Error(`Unexpected .env guard answer: ${JSON.stringify(envGuard)}`);
  }
  if (JSON.parse(readFileSync(result, 'utf8')).envLoad !== 204) throw new Error('Loading .env without printing it was refused');
  step('refuses a shell command that prints a .env file when reads are blocked');

  // The repo scan runs when a project is first looked at; a fix rescans it.
  const repo = `${dir}/repo`;
  mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
  writeFileSync(`${repo}/.env`, 'SECRET=1\n');
  const { id: repoProject } = await api('POST', '/api/projects', { path: repo });
  const { id: repoSession } = await api('POST', '/api/sessions', { projectId: repoProject, cols: 100, rows: 30 });
  const loose = await until('the .env not ignored alert', async () => {
    const state = await api('GET', '/api/state');
    return state.configNeeded.find((c) => c.sessionId === repoSession && c.risk.id === 'env-not-ignored');
  }, 30000);
  if (!loose.risk.files?.includes('.env')) throw new Error(`Unexpected scan risk: ${JSON.stringify(loose.risk)}`);
  await api('POST', `/api/sessions/${repoSession}/config-risks/fix`, { id: 'env-not-ignored' });
  if (!readFileSync(`${repo}/.gitignore`, 'utf8').split('\n').includes('.env')) throw new Error('.env was not added to .gitignore');
  await until('the alert gone after the fix', async () => {
    const state = await api('GET', '/api/state');
    return !state.configNeeded.some((c) => c.risk.id === 'env-not-ignored');
  }, 15000);
  step('scans the repo: a .env git would commit, fixed with Add to .gitignore');

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

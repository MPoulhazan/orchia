// Claude Code's status line command for sessions started by Orchia.
// Claude Code pipes the session's live numbers (cost, context window) on stdin;
// this forwards them to Orchia, then runs the user's own status line, if any,
// with the same input so their terminal looks the same as without Orchia.
//
// Usage: node statusline.mjs <port>
// Env: ORCHIA_SESSION_ID, ORCHIA_TOKEN (set on claude by Orchia),
//      ORCHIA_USER_STATUSLINE (the user's own status line command).

import { spawn } from 'node:child_process';

const REPORT_TIMEOUT = 800;

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

const port = Number(process.argv[2]);
const report = fetch(`http://127.0.0.1:${port}/api/statusline`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-orchia-session': process.env.ORCHIA_SESSION_ID ?? '',
    authorization: `Bearer ${process.env.ORCHIA_TOKEN ?? ''}`,
  },
  body: input || '{}',
  signal: AbortSignal.timeout(REPORT_TIMEOUT),
}).catch(() => {});

const command = process.env.ORCHIA_USER_STATUSLINE;
await Promise.all([report, command ? runUserStatusLine(command) : null]);

/** Runs the command through the shell Claude Code itself would use for it. */
function runUserStatusLine(command) {
  // On Windows, Claude Code uses Git Bash when it has it (and then runs us from
  // it, which sets MSYSTEM or a bash SHELL), PowerShell otherwise.
  const [file, args] =
    process.platform !== 'win32'
      ? ['/bin/sh', ['-c', command]]
      : process.env.MSYSTEM || /bash/.test(process.env.SHELL ?? '')
        ? ['bash', ['-c', command]]
        : ['powershell.exe', ['-NoProfile', '-Command', command]];
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
    child.on('error', resolve);
    child.on('close', resolve);
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

import { execFile } from 'node:child_process';
import type { ConfigRisk } from './configRisks.ts';

/**
 * GitHub's own guard against leaked secrets: secret scanning finds them in the repository,
 * push protection refuses a push that adds one. Both are free on public repositories but
 * can be off; on private ones they are a paid add-on, so Orchia says nothing there. Read
 * with the user's gh login, only when they are an admin of the repository (GitHub shows
 * these settings to admins only, and only an admin can turn them on).
 */

function gh(cwd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'gh',
      args,
      { cwd, timeout: 20_000, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } },
      (err, stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout)),
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

async function repoOf(cwd: string): Promise<string | null> {
  try {
    return (await gh(cwd, ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'])).trim() || null;
  } catch {
    // No gh, not signed in, no GitHub remote: nothing to say.
    return null;
  }
}

/** The risk when a public repository the user administers has secret scanning or push protection off. */
export async function githubSecretScanningRisk(cwd: string): Promise<ConfigRisk | null> {
  const repo = await repoOf(cwd);
  if (!repo) return null;
  let info: any;
  try {
    info = JSON.parse(await gh(cwd, ['api', `repos/${repo}`]));
  } catch {
    return null;
  }
  const settings = info?.security_and_analysis;
  if (info?.visibility !== 'public' || !info?.permissions?.admin || !settings) return null;
  const off = [
    settings.secret_scanning?.status !== 'enabled' && 'secret scanning',
    settings.secret_scanning_push_protection?.status !== 'enabled' && 'push protection',
  ].filter(Boolean);
  if (!off.length) return null;
  return {
    id: 'github-secret-scanning',
    severity: 'moderate',
    title: `GitHub ${off.join(' and ')} ${off.length > 1 ? 'are' : 'is'} off`,
    detail:
      `${repo} is public, so GitHub checks it for leaked secrets and refuses pushes that add one for free, ` +
      `but ${off.join(' and ')} ${off.length > 1 ? 'are' : 'is'} turned off. A second guard behind Orchia's, for commits made outside Claude too.`,
    file: `GitHub settings of ${repo}`,
    shared: false,
    fix: 'github-secret-scanning',
  };
}

/** Turns on secret scanning and push protection for the folder's repository. */
export async function enableGitHubSecretScanning(cwd: string) {
  const repo = await repoOf(cwd);
  if (!repo) throw new Error('This project has no GitHub repository Orchia can reach with gh.');
  const body = { security_and_analysis: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } } };
  try {
    await gh(cwd, ['api', '-X', 'PATCH', `repos/${repo}`, '--input', '-'], JSON.stringify(body));
  } catch (err) {
    throw new Error(`GitHub refused: ${(err as Error).message.split('\n')[0]}`);
  }
}

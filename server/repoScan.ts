import { execFile } from 'node:child_process';
import { appendFile, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { holdsSecrets, isEnvFile, type ConfigRisk } from './configRisks.ts';
import { findSecrets } from './secrets.ts';

/**
 * What a project already has in git that it shouldn't: `.env` files and private keys that
 * are tracked, secrets written in clear in tracked files, and `.env` files that a `git add -A`
 * would pick up. Needs git commands, so it runs in the background: when a project is first
 * looked at, then once a day, and right after a fix. Shown with the other config risks.
 */

const run = promisify(execFile);

const SCAN_EVERY_MS = 24 * 60 * 60 * 1000;
/** Files that hold a private key by their name alone. */
const KEY_FILE = /^id_(rsa|dsa|ecdsa|ed25519)$|\.(p12|pfx|jks|keystore)$/i;
/** Names that may hold a private key or only a certificate: their content decides. */
const MAYBE_KEY_FILE = /\.(pem|key)$/i;
/** The fixed prefixes of secrets.ts, for git grep to find candidate lines fast. */
const SECRET_PREFIXES = 'gh[pousr]_|github_pat_|sk-ant-|T3BlbkFJ|AKIA|ASIA|[sr]k_live_|glpat-|xox[abposr]-|npm_|AIza|BEGIN [A-Z ]*PRIVATE KEY';
/** A line with a documentation value (AWS's AKIAIOSFODNN7EXAMPLE) holds no real secret. */
const EXAMPLE_VALUE = /EXAMPLE/;
const MAX_SECRET_RISKS = 20;
const MAX_FILE_BYTES = 1_000_000;

export class RepoScanner {
  private scans = new Map<string, { at: number; risks: ConfigRisk[] }>();
  private running = new Set<string>();

  constructor(private onChange: () => void) {}

  /** The last scan's risks for this folder; starts a scan when there is none yet or it is a day old. */
  get(cwd: string): ConfigRisk[] {
    const scan = this.scans.get(cwd);
    if (!scan || Date.now() - scan.at > SCAN_EVERY_MS) this.rescan(cwd);
    return scan?.risks ?? [];
  }

  /** Scans now, in the background, then tells the server; one scan per folder at a time. */
  rescan(cwd: string) {
    if (this.running.has(cwd)) return;
    this.running.add(cwd);
    scanRepo(cwd)
      .catch(() => [])
      .then((risks) => {
        this.scans.set(cwd, { at: Date.now(), risks });
        this.running.delete(cwd);
        this.onChange();
      });
  }
}

/** Adds the untracked `.env` files of a project to its .gitignore, by name. */
export async function ignoreEnvFiles(cwd: string, files: string[]) {
  const path = join(cwd, '.gitignore');
  let current = '';
  try {
    current = await readFile(path, 'utf8');
  } catch {}
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const add = [...new Set(files)].filter((f) => !have.has(f) && !have.has(`/${f}`));
  if (!add.length) return;
  const lead = current && !current.endsWith('\n') ? '\n' : '';
  await appendFile(path, `${lead}${add.join('\n')}\n`);
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd, maxBuffer: 50 * 1024 * 1024, timeout: 30000, windowsHide: true });
    return stdout;
  } catch (err: any) {
    // git grep exits 1 when nothing matches.
    return typeof err?.stdout === 'string' ? err.stdout : '';
  }
}

async function readSmall(path: string): Promise<string | null> {
  try {
    if ((await stat(path)).size > MAX_FILE_BYTES) return null;
    const text = await readFile(path, 'utf8');
    return text.includes('\0') ? null : text;
  } catch {
    return null;
  }
}

export async function scanRepo(cwd: string): Promise<ConfigRisk[]> {
  if (!(await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim()) return [];
  const tracked = (await git(cwd, ['ls-files', '-z'])).split('\0').filter(Boolean);
  const risks: ConfigRisk[] = [];
  const reported = new Set<string>();
  const risk = (r: Omit<ConfigRisk, 'shared'>) => risks.push({ ...r, shared: false });

  for (const file of tracked) {
    const name = basename(file);
    if (isEnvFile(name)) {
      // Only browser-public values (VITE_…), or nothing set: no secret to leak.
      if (!holdsSecrets((await readSmall(join(cwd, file))) ?? '')) continue;
      reported.add(file);
      risk({
        id: `env-tracked:${file}`,
        severity: 'high',
        title: `${name} is committed to git`,
        detail: `${file} is tracked, so its values are in the repository's history and on every clone. Revoke the secrets it holds, then run git rm --cached ${file} and add it to .gitignore.`,
        file,
        fix: null,
      });
    } else if (KEY_FILE.test(name) || (MAYBE_KEY_FILE.test(name) && /PRIVATE KEY/.test((await readSmall(join(cwd, file))) ?? ''))) {
      reported.add(file);
      risk({
        id: `key-tracked:${file}`,
        severity: 'high',
        title: 'A private key is committed to git',
        detail: `${file} holds a private key and is tracked, so it is in the repository's history. Replace the key, then run git rm --cached ${file} and add it to .gitignore.`,
        file,
        fix: null,
      });
    }
  }

  // Secrets written in clear in tracked files, first place each one appears.
  const grep = await git(cwd, ['grep', '-I', '-n', '-E', '--no-color', '-e', SECRET_PREFIXES, '--', '.']);
  const keyFiles = new Set<string>();
  const seen = new Set<string>();
  for (const line of grep.split('\n')) {
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (!m || reported.has(m[1])) continue;
    // A private key spans lines: read its whole file once.
    if (/PRIVATE KEY/.test(m[3])) {
      keyFiles.add(m[1]);
      continue;
    }
    for (const hit of findSecrets(m[3])) {
      if (seen.has(hit.fingerprint) || EXAMPLE_VALUE.test(m[3])) continue;
      seen.add(hit.fingerprint);
      if (seen.size > MAX_SECRET_RISKS) break;
      risk(secretRisk(hit.label, hit.masked, `${m[1]}:${m[2]}`, hit.fingerprint));
    }
  }
  for (const file of keyFiles) {
    for (const hit of findSecrets((await readSmall(join(cwd, file))) ?? '')) {
      if (seen.has(hit.fingerprint)) continue;
      seen.add(hit.fingerprint);
      risk(secretRisk(hit.label, hit.masked, file, hit.fingerprint));
    }
  }

  // `.env` files on disk that git doesn't ignore: one `git add -A` away from the history.
  const loose = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter((f) => f && isEnvFile(basename(f)));
  if (loose.length) {
    risk({
      id: 'env-not-ignored',
      severity: 'moderate',
      title: '.env files are not in .gitignore',
      detail: `${loose.slice(0, 3).join(', ')}${loose.length > 3 ? '…' : ''}: git doesn't ignore ${loose.length > 1 ? 'them' : 'it'}, so the next git add -A commits the secrets.`,
      file: '.gitignore',
      fix: 'ignore-env',
      files: loose,
    });
  }
  return risks;
}

function secretRisk(label: string, masked: string, where: string, fingerprint: string): Omit<ConfigRisk, 'shared'> {
  return {
    id: `secret-tracked:${fingerprint}`,
    severity: 'high',
    title: `${label} written in the code`,
    detail: `${masked} in ${where}, tracked by git: it is in the history and on every clone. Revoke it, then read it from an environment variable instead.`,
    file: where.replace(/:\d+$/, ''),
    fix: null,
  };
}

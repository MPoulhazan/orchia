import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { parseGitHubSource, type GitHubSource } from './githubSource.ts';
import { frontmatter, skillsDir, type SkillScope } from './skills.ts';

/**
 * Skills straight from a GitHub repository, the way most skills are published.
 *
 * The repository is fetched once with git (depth 1, into a temp folder), looked
 * through for SKILL.md files, and kept a few minutes so adding right after
 * looking doesn't fetch it again. Public repositories only: git never prompts.
 */

export interface RepoSkill {
  name: string;
  description: string;
  /** Folder in the repository, with forward slashes. */
  path: string;
  /** The SKILL.md on GitHub, to read before adding. */
  url: string;
}

export interface RepoPreview {
  repo: string;
  skills: RepoSkill[];
  /** Names to tick at first: the ones the link points at, or the only one. */
  picked: string[];
}

interface Fetched {
  at: number;
  dir: string;
  commit: string;
}

const KEEP_MS = 10 * 60_000;
const fetched = new Map<string, Fetched>();

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout.trim())),
    );
  });
}

function parse(text: string): GitHubSource {
  const source = parseGitHubSource(text);
  if (!source) throw new Error('That is not a GitHub repository link');
  return source;
}

async function fetchRepo(source: GitHubSource): Promise<Fetched> {
  const key = `${source.owner}/${source.repo}@${source.ref ?? ''}`.toLowerCase();
  for (const [k, f] of fetched) {
    if (Date.now() - f.at > KEEP_MS) {
      rmSync(f.dir, { recursive: true, force: true });
      fetched.delete(k);
    }
  }
  const hit = fetched.get(key);
  if (hit && existsSync(hit.dir)) return hit;

  const dir = mkdtempSync(join(tmpdir(), 'agenthub-skills-'));
  try {
    await git(dir, ['init', '-q']);
    await git(dir, ['fetch', '-q', '--depth', '1', `https://github.com/${source.owner}/${source.repo}.git`, source.ref ?? 'HEAD']);
    await git(dir, ['checkout', '-q', 'FETCH_HEAD']);
    const commit = await git(dir, ['rev-parse', 'HEAD']);
    const entry = { at: Date.now(), dir, commit };
    fetched.set(key, entry);
    return entry;
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    const message = (err as Error).message;
    if (/not found|could not read Username|Authentication failed/i.test(message)) {
      throw new Error(`No public GitHub repository at ${source.owner}/${source.repo}`);
    }
    if (source.ref && /couldn't find remote ref|not our ref/i.test(message)) {
      throw new Error(`${source.owner}/${source.repo} has no branch or tag ${source.ref}`);
    }
    throw new Error(`Could not get ${source.owner}/${source.repo}: ${message.split('\n')[0]}`);
  }
}

const forClaude = (path: string) => /(^|[\\/])\.?claude[\\/]/i.test(path);

/** Every folder with a SKILL.md, shallowest first; one per name. */
function findSkills(root: string, under?: string): { name: string; description: string; dir: string }[] {
  const start = under ? join(root, under) : root;
  const out: { name: string; description: string; dir: string }[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: start, depth: 0 }];
  let visited = 0;
  while (queue.length && visited++ < 5000) {
    const { dir, depth } = queue.shift()!;
    let text: string | null = null;
    try {
      text = readFileSync(join(dir, 'SKILL.md'), 'utf8');
    } catch {
      // Not a skill folder.
    }
    if (text !== null) {
      const meta = frontmatter(text);
      const name = meta.name || basename(dir);
      const skill = { name, description: meta.description ?? '', dir };
      const same = out.findIndex((s) => s.name === name);
      if (same === -1) out.push(skill);
      // Repositories often ship one copy per agent: keep Claude's.
      else if (forClaude(relative(root, dir)) && !forClaude(relative(root, out[same].dir))) out[same] = skill;
      continue; // A skill's own folders are its files, not more skills.
    }
    if (depth >= 6) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory() && e.name !== '.git' && e.name !== 'node_modules') queue.push({ dir: join(dir, e.name), depth: depth + 1 });
    }
  }
  return out;
}

export async function previewRepo(text: string): Promise<RepoPreview> {
  const source = parse(text);
  const repo = await fetchRepo(source);
  const found = findSkills(repo.dir, source.path);
  if (!found.length) throw new Error(`No skills in ${source.owner}/${source.repo}${source.path ? `/${source.path}` : ''} (no SKILL.md found)`);
  const skills = found.map((s) => {
    const path = relative(repo.dir, s.dir).replace(/\\/g, '/');
    return {
      name: s.name,
      description: s.description,
      path,
      url: `https://github.com/${source.owner}/${source.repo}/blob/${repo.commit}/${path ? `${path}/` : ''}SKILL.md`,
    };
  });
  const named = skills.filter((s) => source.skills.includes(s.name)).map((s) => s.name);
  const picked = named.length ? named : skills.length === 1 || source.path ? skills.map((s) => s.name) : [];
  return { repo: `${source.owner}/${source.repo}`, skills, picked };
}

/** Copies the named skills of a repository into the project, or the personal folder. */
export async function importSkills(cwd: string, text: string, names: string[], scope: SkillScope): Promise<number> {
  const source = parse(text);
  const repo = await fetchRepo(source);
  const chosen = findSkills(repo.dir, source.path).filter((s) => names.includes(s.name));
  if (!chosen.length) throw new Error('Pick at least one skill');
  const target = skillsDir(cwd, scope);
  // Named after the skill, so the folder reads like the list; repositories often use "skill" or "v1" folders.
  const folders = chosen.map((s) => (/^[\w.-]+$/.test(s.name) && !/^\.+$/.test(s.name) ? s.name : s.dir === repo.dir ? source.repo : basename(s.dir)));
  const taken = folders.filter((f) => existsSync(join(target, f)));
  if (taken.length) throw new Error(`Already there: ${taken.join(', ')}`);
  chosen.forEach((s, i) => cpSync(s.dir, join(target, folders[i]), { recursive: true, filter: (src) => basename(src) !== '.git' }));
  return chosen.length;
}

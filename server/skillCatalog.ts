import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Skill } from './skills.ts';

/**
 * Suggested skills: a short, hand-picked catalog, matched against what the
 * project uses.
 *
 * Only local signals decide (dependencies, a few files, the project's MCP
 * servers), and they stay narrow on purpose: no suggestion is better than a wrong
 * one. Each entry is pinned to a commit, so a suggestion never changes under us.
 * One suggestion per category: two skills for the same job fight over the same
 * tasks, so a covered category suggests nothing more.
 */

interface CatalogEntry {
  /** The skill's name, as its SKILL.md says. */
  name: string;
  repo: string;
  commit: string;
  path: string;
  summary: string;
  category: string;
  /** What makes it relevant: name → how the reason says it ("Because it uses React"). */
  when: { deps?: Record<string, string>; files?: Record<string, string>; mcp?: Record<string, string> };
  /** Installed skills or plugins that do the same job. */
  sameAs?: string[];
}

// Frameworks before libraries: the reason names the most specific one.
const WEB_UI = {
  next: 'Next.js',
  nuxt: 'Nuxt',
  astro: 'Astro',
  '@angular/core': 'Angular',
  react: 'React',
  vue: 'Vue',
  svelte: 'Svelte',
  'solid-js': 'Solid',
};

/** In order of preference: the first match of a category wins. */
const CATALOG: CatalogEntry[] = [
  {
    name: 'impeccable',
    repo: 'pbakaus/impeccable',
    commit: '919dbeba520df760a157fe635be62faae88d58da',
    path: '.claude/skills/impeccable',
    summary: 'Design commands to audit, polish and refine the interface',
    category: 'ui-design',
    when: { deps: WEB_UI },
  },
  {
    name: 'frontend-design',
    repo: 'anthropics/skills',
    commit: 'dbd4588f9e1033efb41dad4bef2f7947c8993d44',
    path: 'skills/frontend-design',
    summary: 'Distinctive, intentional visual design for new or reshaped UI',
    category: 'ui-design',
    when: { deps: WEB_UI },
    sameAs: ['frontend-design'],
  },
  {
    name: 'design-taste-frontend',
    repo: 'leonxlnx/taste-skill',
    commit: 'd237dd399d57524945c0c81327da5da19f7a468d',
    path: 'skills/taste-skill',
    summary: 'Bolder design for landing pages, portfolios and redesigns',
    category: 'ui-design',
    when: { deps: WEB_UI },
    sameAs: ['design-taste-frontend-v1'],
  },
  {
    name: 'vercel-react-best-practices',
    repo: 'vercel-labs/agent-skills',
    commit: '063bee94c3f4df8453406c830b0a7df0f2860278',
    path: 'skills/react-best-practices',
    summary: 'React and Next.js performance rules from Vercel',
    category: 'react',
    when: { deps: { next: 'Next.js', react: 'React' } },
  },
  {
    name: 'vercel-react-native-skills',
    repo: 'vercel-labs/agent-skills',
    commit: '063bee94c3f4df8453406c830b0a7df0f2860278',
    path: 'skills/react-native-skills',
    summary: 'React Native and Expo practices for fast mobile apps',
    category: 'react-native',
    when: { deps: { 'react-native': 'React Native', expo: 'Expo' } },
  },
  {
    name: 'webapp-testing',
    repo: 'anthropics/skills',
    commit: 'dbd4588f9e1033efb41dad4bef2f7947c8993d44',
    path: 'skills/webapp-testing',
    summary: 'Drive and check the web app in a browser with Playwright',
    category: 'web-testing',
    when: {
      deps: { playwright: 'Playwright', '@playwright/test': 'Playwright' },
      files: { 'playwright.config.ts': 'Playwright', 'playwright.config.js': 'Playwright' },
    },
  },
  {
    name: 'supabase',
    repo: 'supabase/agent-skills',
    commit: 'c9be0e931b7930f7d02126d04774d904c381e7d7',
    path: 'skills/supabase',
    summary: 'Database, Auth, Edge Functions and the Supabase CLI',
    category: 'supabase',
    when: {
      deps: { '@supabase/supabase-js': 'Supabase', '@supabase/ssr': 'Supabase', supabase: 'Supabase' },
      files: { 'supabase/config.toml': 'Supabase' },
      mcp: { supabase: 'the Supabase MCP server' },
    },
  },
  {
    name: 'supabase-postgres-best-practices',
    repo: 'supabase/agent-skills',
    commit: 'c9be0e931b7930f7d02126d04774d904c381e7d7',
    path: 'skills/supabase-postgres-best-practices',
    summary: 'Postgres schema, query and index practices',
    category: 'postgres',
    when: { deps: { pg: 'Postgres', postgres: 'Postgres', psycopg: 'Postgres', 'psycopg2-binary': 'Postgres', asyncpg: 'Postgres' } },
  },
  {
    name: 'mcp-builder',
    repo: 'anthropics/skills',
    commit: 'dbd4588f9e1033efb41dad4bef2f7947c8993d44',
    path: 'skills/mcp-builder',
    summary: 'Build solid MCP servers for LLM tools',
    category: 'mcp',
    when: { deps: { '@modelcontextprotocol/sdk': 'the MCP SDK', mcp: 'the MCP SDK', fastmcp: 'FastMCP' } },
  },
  {
    name: 'deploy-to-vercel',
    repo: 'vercel-labs/agent-skills',
    commit: '063bee94c3f4df8453406c830b0a7df0f2860278',
    path: 'skills/deploy-to-vercel',
    summary: 'Deploy the app to Vercel when asked',
    category: 'deploy',
    when: { deps: { vercel: 'Vercel' }, files: { 'vercel.json': 'Vercel' } },
  },
  {
    name: 'pdf',
    repo: 'anthropics/skills',
    commit: 'dbd4588f9e1033efb41dad4bef2f7947c8993d44',
    path: 'skills/pdf',
    summary: 'Read, fill, merge and create PDF files',
    category: 'pdf',
    when: {
      deps: { 'pdf-lib': 'pdf-lib', pdfkit: 'PDFKit', 'pdfjs-dist': 'PDF.js', pypdf: 'pypdf', pdfplumber: 'pdfplumber', reportlab: 'ReportLab', pymupdf: 'PyMuPDF' },
    },
  },
  {
    name: 'docx',
    repo: 'anthropics/skills',
    commit: 'dbd4588f9e1033efb41dad4bef2f7947c8993d44',
    path: 'skills/docx',
    summary: 'Create and edit Word documents',
    category: 'docx',
    when: { deps: { docx: 'docx', 'python-docx': 'python-docx', mammoth: 'Mammoth' } },
  },
  {
    name: 'xlsx',
    repo: 'anthropics/skills',
    commit: 'dbd4588f9e1033efb41dad4bef2f7947c8993d44',
    path: 'skills/xlsx',
    summary: 'Create and edit spreadsheets with formulas and charts',
    category: 'xlsx',
    when: { deps: { exceljs: 'ExcelJS', xlsx: 'SheetJS', openpyxl: 'openpyxl' } },
  },
  {
    name: 'pptx',
    repo: 'anthropics/skills',
    commit: 'dbd4588f9e1033efb41dad4bef2f7947c8993d44',
    path: 'skills/pptx',
    summary: 'Create and edit PowerPoint decks',
    category: 'pptx',
    when: { deps: { pptxgenjs: 'PptxGenJS', 'python-pptx': 'python-pptx' } },
  },
];

export interface SuggestedSkill {
  name: string;
  summary: string;
  repo: string;
  /** A link the GitHub import reads: the skill's folder at the pinned commit. */
  source: string;
  reason: string;
  stars?: number;
}

// ---- What the project uses -------------------------------------------------------------

interface Signals {
  deps: Set<string>;
  files: Set<string>;
  mcp: Set<string>;
}

const signalsCache = new Map<string, { at: number; signals: Signals }>();
const SIGNALS_TTL_MS = 60_000;

const read = (file: string) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/** Python names compare without case, and with `_` and `-` alike. */
const pyName = (name: string) => name.toLowerCase().replace(/_/g, '-');

function addDeps(dir: string, deps: Set<string>) {
  const pkg = read(join(dir, 'package.json'));
  if (pkg) {
    try {
      const json = JSON.parse(pkg);
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) Object.keys(json[field] ?? {}).forEach((d) => deps.add(d));
    } catch {
      // A broken package.json says nothing.
    }
  }
  for (const line of read(join(dir, 'requirements.txt'))?.split(/\r?\n/) ?? []) {
    const name = line.match(/^\s*([A-Za-z0-9][\w.-]*)/)?.[1];
    if (name) deps.add(pyName(name));
  }
  // Quoted requirements anywhere in pyproject: "fastapi>=0.1", 'mcp[cli]'.
  for (const m of read(join(dir, 'pyproject.toml'))?.matchAll(/["']([A-Za-z0-9][\w.-]*)\s*(?=[<>=~!\[;"'])/g) ?? []) deps.add(pyName(m[1]));
}

function subfolders(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

function projectSignals(cwd: string): Signals {
  const key = cwd.toLowerCase();
  const hit = signalsCache.get(key);
  if (hit && Date.now() - hit.at < SIGNALS_TTL_MS) return hit.signals;

  const deps = new Set<string>();
  // The project, its direct folders (web/, server/…) and the usual monorepo ones.
  addDeps(cwd, deps);
  for (const dir of subfolders(cwd)) {
    addDeps(dir, deps);
    if (/[\\/](apps|packages|services)$/.test(dir)) subfolders(dir).forEach((d) => addDeps(d, deps));
  }
  const files = new Set(
    CATALOG.flatMap((e) => Object.keys(e.when.files ?? {})).filter((f) => existsSync(join(cwd, f))),
  );
  let mcp = new Set<string>();
  try {
    mcp = new Set(Object.keys(JSON.parse(read(join(cwd, '.mcp.json')) ?? '{}').mcpServers ?? {}).map((n) => n.toLowerCase()));
  } catch {
    // No usable .mcp.json.
  }
  const signals = { deps, files, mcp };
  signalsCache.set(key, { at: Date.now(), signals });
  return signals;
}

/** What made an entry match, said the way the reason shows it. */
function match(entry: CatalogEntry, signals: Signals): string | null {
  for (const [dep, label] of Object.entries(entry.when.deps ?? {})) if (signals.deps.has(dep)) return `it uses ${label}`;
  for (const [file, label] of Object.entries(entry.when.files ?? {})) if (signals.files.has(file)) return `it uses ${label}`;
  for (const [server, label] of Object.entries(entry.when.mcp ?? {})) if (signals.mcp.has(server)) return `it has ${label}`;
  return null;
}

// ---- Popularity ----------------------------------------------------------------------

const stars = new Map<string, { at: number; count: number | undefined }>();
const STARS_TTL_MS = 24 * 3600_000;

/** GitHub stars, only ever shown. Unauthenticated (60 calls an hour): cached a day, nothing on failure. */
async function repoStars(repo: string): Promise<number | undefined> {
  const hit = stars.get(repo);
  if (hit && Date.now() - hit.at < STARS_TTL_MS) return hit.count;
  let count: number | undefined;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'agenthub' },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) count = Number((await res.json()).stargazers_count) || undefined;
  } catch {
    // Offline or rate-limited: no stars.
  }
  stars.set(repo, { at: Date.now(), count });
  return count;
}

// ---- Suggestions ---------------------------------------------------------------------

const MAX_SUGGESTIONS = 3;

/** Up to three skills worth adding to the project, best first. */
export function suggestSkills(cwd: string, have: Skill[], dismissed: string[]): (SuggestedSkill & { category: string })[] {
  const signals = projectSignals(cwd);
  const haveNames = new Set(have.map((s) => s.name));
  const covered = new Set(CATALOG.filter((e) => [e.name, ...(e.sameAs ?? [])].some((n) => haveNames.has(n))).map((e) => e.category));
  const out: (SuggestedSkill & { category: string })[] = [];
  for (const entry of CATALOG) {
    if (out.length === MAX_SUGGESTIONS) break;
    if (covered.has(entry.category) || dismissed.includes(entry.name) || out.some((s) => s.category === entry.category)) continue;
    const why = match(entry, signals);
    if (!why) continue;
    out.push({
      name: entry.name,
      summary: entry.summary,
      repo: entry.repo,
      source: `https://github.com/${entry.repo}/tree/${entry.commit}/${entry.path}`,
      reason: `Because ${why}`,
      category: entry.category,
    });
  }
  return out;
}

/** The whole catalog minus what the project has, for searching it in the palette. */
export function catalogSkills(have: Skill[]): Omit<SuggestedSkill, 'reason'>[] {
  const haveNames = new Set(have.map((s) => s.name));
  return CATALOG.filter((e) => !haveNames.has(e.name)).map((e) => ({
    name: e.name,
    summary: e.summary,
    repo: e.repo,
    source: `https://github.com/${e.repo}/tree/${e.commit}/${e.path}`,
  }));
}

/** The suggestions with their stars, for the palette. */
export async function suggestionsWithStars(cwd: string, have: Skill[], dismissed: string[]): Promise<SuggestedSkill[]> {
  const list = suggestSkills(cwd, have, dismissed);
  return Promise.all(list.map(async ({ category: _, ...s }) => ({ ...s, stars: await repoStars(s.repo) })));
}

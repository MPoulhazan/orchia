/**
 * Security notes on the connectors, skills and plugins a project uses, from the public
 * catalog awesome-vetted-claude-code (tools.json: how to recognize each tool, and its
 * advisories with affected and patched versions). Fetched once a day and cached; nothing
 * about the user is sent. Only what can be known is claimed: a version pinned in the
 * command is checked against the ranges; `npx pkg` / `pkg@latest` and hosted servers run
 * the latest release, so only advisories with no fix concern them; otherwise the note
 * just says which version fixed it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Connector } from './mcp.ts';
import { CONFIG_DIR } from './projects.ts';
import type { Skill } from './skills.ts';

const SOURCE = 'https://raw.githubusercontent.com/MPoulhazan/awesome-vetted-claude-code/main/tools.json';
const CATALOG = 'https://github.com/MPoulhazan/awesome-vetted-claude-code/blob/main/catalog';
const CACHE_FILE = join(CONFIG_DIR, 'advisories.json');
const REFRESH_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;

type Severity = 'low' | 'moderate' | 'high' | 'critical';
const SEVERITY_RANK: Record<Severity, number> = { low: 0, moderate: 1, high: 2, critical: 3 };

interface Advisory {
  id: string;
  cve?: string;
  severity: Severity;
  summary: string;
  /** "< 1.1.0", ">= 0.22.0, < 1.1.2", "<= 1.6.1" */
  affected?: string;
  /** Missing when there is no fix yet. */
  patched?: string;
  url?: string;
}

interface VettedTool {
  id: string;
  name: string;
  detect?: { npm?: string[]; pypi?: string[]; plugins?: string[]; skills?: string[]; mcp_urls?: string[] };
  security?: { advisories?: Advisory[] };
}

export interface SecurityNote {
  /** `affected`: the version in use is in an affected range; `unfixed`: no fix exists yet; `check`: fixed in a version we can't see. */
  level: 'affected' | 'unfixed' | 'check';
  severity: Severity;
  tool: string;
  summary: string;
  fixedIn: string | null;
  /** The tool's review in the catalog, which lists its advisories. */
  url: string;
  /** The advisories it is about, to remember a dismissed alert until a new one appears. */
  ids: string[];
}

let tools: VettedTool[] = [];
let fetchedAt = 0;
let lastTry = 0;

try {
  const cached = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  tools = Array.isArray(cached.tools) ? cached.tools : [];
  fetchedAt = Number(cached.at) || 0;
} catch {}

/** Fetches the catalog when the copy is a day old; keeps the old copy when offline. */
export async function refreshAdvisories(): Promise<void> {
  const now = Date.now();
  if (now - fetchedAt < REFRESH_MS || now - lastTry < RETRY_MS) return;
  lastTry = now;
  try {
    const res = await fetch(SOURCE, { signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'orchia' } });
    if (!res.ok) return;
    const body = await res.json();
    if (!Array.isArray(body?.tools)) return;
    tools = body.tools;
    fetchedAt = now;
    writeFileSync(CACHE_FILE, JSON.stringify({ at: now, tools }));
  } catch {}
}

/** "latest" when the command runs the newest release, a version when it pins one, null when we can't tell. */
type InUse = { tool: VettedTool; version: string | null | 'latest' };

export function connectorNote(c: Connector): SecurityNote | null {
  const target = c.target.trim();
  if (/^https?:\/\//i.test(target)) {
    const url = normalizeUrl(target);
    const tool = tools.find((t) => t.detect?.mcp_urls?.some((u) => normalizeUrl(u) === url));
    return tool ? noteFor({ tool, version: 'latest' }) : null;
  }
  const words = target.split(/\s+/);
  for (const tool of tools) {
    const found = packageVersion(words, [...(tool.detect?.npm ?? []), ...(tool.detect?.pypi ?? [])]);
    if (found !== undefined) return noteFor({ tool, version: found });
  }
  return null;
}

export function skillNote(s: Skill): SecurityNote | null {
  const id = s.id.replace(/^(plugin|skill):/, '');
  const tool = tools.find((t) =>
    s.kind === 'plugin'
      ? t.detect?.plugins?.some((p) => p === id || p === id.split('@')[0])
      : t.detect?.skills?.includes(s.name),
  );
  return tool ? noteFor({ tool, version: null }) : null;
}

/**
 * The version a command line runs of one of these packages: `pkg@1.2.3` or `pkg==1.2.3`
 * pins it; `npx pkg`, `uvx pkg` or `pkg@latest` take the newest; the package's own
 * command (`pkg serve`) is an installed copy of unknown version. Undefined: not there.
 */
function packageVersion(words: string[], packages: string[]): string | null | 'latest' | undefined {
  for (const [i, word] of words.entries()) {
    for (const pkg of packages) {
      if (word === pkg) return i === 0 ? null : 'latest';
      const pin = word.startsWith(pkg) ? word.slice(pkg.length).match(/^(?:@|==)(\S+)$/) : null;
      if (pin) return /^(latest|next)$/.test(pin[1]) ? 'latest' : pin[1];
    }
  }
  return undefined;
}

function noteFor({ tool, version }: InUse): SecurityNote | null {
  const advisories = tool.security?.advisories ?? [];
  const pinned = version && version !== 'latest' ? version : null;
  const unfixed = advisories.filter((a) => !a.patched && (!pinned || inRange(pinned, a.affected)));
  const affected = pinned ? advisories.filter((a) => a.patched && inRange(pinned, a.affected)) : [];
  const unseen = version === null ? advisories.filter((a) => a.patched) : [];
  const [level, list]: [SecurityNote['level'], Advisory[]] | [null, Advisory[]] = unfixed.length
    ? ['unfixed', unfixed]
    : affected.length
      ? ['affected', affected]
      : unseen.length
        ? ['check', unseen]
        : [null, []];
  if (!level) return null;
  const worst = list.reduce((a, b) => (SEVERITY_RANK[b.severity] > SEVERITY_RANK[a.severity] ? b : a));
  const fixes = list.map((a) => a.patched).filter((v): v is string => !!v);
  return {
    level,
    severity: worst.severity,
    tool: tool.name,
    summary: worst.summary,
    fixedIn: level === 'unfixed' || !fixes.length ? null : fixes.reduce((a, b) => (compare(b, a) > 0 ? b : a)),
    url: `${CATALOG}/${tool.id}.md`,
    ids: list.map((a) => a.id).sort(),
  };
}

/** Unknown range: assume it applies. */
function inRange(version: string, range?: string): boolean {
  if (!range) return true;
  return range.split(',').every((part) => {
    const m = part.trim().match(/^(<=|<|>=|>|=)?\s*v?([\d.]+)/);
    if (!m) return true;
    const c = compare(version, m[2]);
    switch (m[1]) {
      case '<':
        return c < 0;
      case '<=':
        return c <= 0;
      case '>':
        return c > 0;
      case '>=':
        return c >= 0;
      default:
        return c === 0;
    }
  });
}

/** Numeric dotted versions; a pre-release tag is ignored. */
function compare(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[-+]/)[0].split('.').map(Number);
  const pb = b.replace(/^v/, '').split(/[-+]/)[0].split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function normalizeUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, '');
}

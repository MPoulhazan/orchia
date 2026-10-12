import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServerConfig } from './mcpSource.ts';
import type { Connector } from './mcp.ts';
import { projectDeps } from './skillCatalog.ts';

/**
 * Connectors worth offering: a short, hand-picked list of well-known MCP servers,
 * suggested when the project shows it uses the service. Like the skill catalog,
 * only local signals decide, and they stay narrow: no suggestion beats a wrong one.
 */

interface CatalogConnector {
  name: string;
  title: string;
  summary: string;
  server: McpServerConfig;
  /** What makes it relevant: name → how the reason says it ("Because it uses Supabase"). */
  when?: { deps?: Record<string, string>; files?: Record<string, string>; gitHost?: string };
}

const CATALOG: CatalogConnector[] = [
  {
    name: 'supabase',
    title: 'Supabase',
    summary: 'Query tables, run migrations, read logs',
    server: { type: 'http', url: 'https://mcp.supabase.com/mcp' },
    when: { deps: { '@supabase/supabase-js': 'Supabase', '@supabase/ssr': 'Supabase' }, files: { 'supabase/config.toml': 'Supabase' } },
  },
  {
    name: 'github',
    title: 'GitHub',
    summary: 'Issues, pull requests, Actions runs',
    server: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' },
    when: { gitHost: 'github.com' },
  },
  {
    name: 'vercel',
    title: 'Vercel',
    summary: 'Deployments, build logs, domains',
    server: { type: 'http', url: 'https://mcp.vercel.com' },
    when: { files: { 'vercel.json': 'Vercel', '.vercel': 'Vercel' } },
  },
  {
    name: 'playwright',
    title: 'Playwright',
    summary: 'Drive a real browser: open pages, click, take screenshots',
    server: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
    when: {
      deps: { '@playwright/test': 'Playwright', playwright: 'Playwright' },
      files: { 'playwright.config.ts': 'Playwright', 'playwright.config.js': 'Playwright' },
    },
  },
  {
    name: 'notion',
    title: 'Notion',
    summary: 'Search, read and write pages and databases',
    server: { type: 'http', url: 'https://mcp.notion.com/mcp' },
  },
  {
    name: 'sentry',
    title: 'Sentry',
    summary: 'Errors and their stack traces',
    server: { type: 'http', url: 'https://mcp.sentry.dev/mcp' },
    when: { deps: { '@sentry/node': 'Sentry', '@sentry/react': 'Sentry', '@sentry/nextjs': 'Sentry', '@sentry/browser': 'Sentry' } },
  },
  {
    name: 'linear',
    title: 'Linear',
    summary: 'Issues, projects and cycles',
    server: { type: 'http', url: 'https://mcp.linear.app/mcp' },
  },
  {
    name: 'stripe',
    title: 'Stripe',
    summary: 'Customers, payments, products',
    server: { type: 'http', url: 'https://mcp.stripe.com' },
    when: { deps: { stripe: 'Stripe', '@stripe/stripe-js': 'Stripe' } },
  },
  {
    name: 'context7',
    title: 'Context7',
    summary: 'Up-to-date docs and examples for libraries',
    server: { type: 'http', url: 'https://mcp.context7.com/mcp' },
  },
];

export interface CatalogItem {
  name: string;
  title: string;
  summary: string;
  server: McpServerConfig;
  /** "Because it uses Supabase", when suggested for this project. */
  reason?: string;
}

function gitHost(cwd: string): string {
  try {
    return readFileSync(join(cwd, '.git', 'config'), 'utf8').match(/url\s*=\s*\S*?(github\.com|gitlab\.com|bitbucket\.org)/)?.[1] ?? '';
  } catch {
    return '';
  }
}

function reasonFor(entry: CatalogConnector, cwd: string, deps: Set<string>, host: string): string | undefined {
  const when = entry.when ?? {};
  for (const [dep, label] of Object.entries(when.deps ?? {})) if (deps.has(dep)) return `Because it uses ${label}`;
  for (const [file, label] of Object.entries(when.files ?? {})) if (existsSync(join(cwd, file))) return `Because it uses ${label}`;
  if (when.gitHost && host === when.gitHost) return 'Because its code is on GitHub';
  return undefined;
}

/** The same service, already there: same name, same title (a claude.ai connector), or same URL host. */
export function sameConnector(entry: { name: string; title?: string; server: McpServerConfig }, c: Connector): boolean {
  const host = (url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  };
  if (c.name.toLowerCase() === entry.name || c.label.toLowerCase() === (entry.title ?? entry.name).toLowerCase()) return true;
  return entry.server.type !== 'stdio' && /^https?:/.test(c.target) && host(c.target) === host(entry.server.url);
}

/** The catalog minus what the project has, suggestions first. */
export function catalogConnectors(cwd: string, have: Connector[]): CatalogItem[] {
  const deps = projectDeps(cwd);
  const host = gitHost(cwd);
  const items = CATALOG.filter((e) => !have.some((c) => sameConnector(e, c))).map((entry): CatalogItem => {
    const { when: _, ...item } = entry;
    return { ...item, reason: reasonFor(entry, cwd, deps, host) };
  });
  return [...items.filter((i) => i.reason), ...items.filter((i) => !i.reason)];
}

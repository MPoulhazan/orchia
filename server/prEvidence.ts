import { execFile } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './projects.ts';
import type { PullRequestState } from './pullRequests.ts';
import { redactSecrets } from './secrets.ts';

/**
 * A single comment on a session's pull request saying how it was made: which conversation, model,
 * estimated cost and approved permissions. Posted with the user's gh login, only for projects
 * that turned it on, because the comment can be public.
 *
 * What it may hold is decided by EvidenceRow: never a prompt, terminal output, a command or a file.
 * A session is named by a short ID, as its name can be the start of its first prompt.
 */

export const MARKER = '<!-- orchia:evidence -->';
/** Editing a comment often is noise on the pull request: the cost moves with every turn. */
export const MIN_UPDATE_MS = 5 * 60 * 1000;
const KEEP_FOR_MS = 90 * 24 * 60 * 60 * 1000;

export interface EvidenceRow {
  session: string;
  model: string | null;
  costUsd: number | null;
  /** Requests approved in Orchia, by tool. */
  approved: Record<string, number>;
}

export interface EvidenceSource {
  url: string;
  rows: EvidenceRow[];
}

const cell = (text: string) => text.replace(/[|`<>\r\n]/g, '');

function approvedCell(approved: Record<string, number>): string {
  const tools = Object.entries(approved).sort((a, b) => b[1] - a[1]);
  return tools.length ? tools.map(([tool, n]) => `${cell(tool)} ×${n}`).join(', ') : '—';
}

export function evidenceBody(rows: EvidenceRow[]): string {
  const lines = rows.map((r) => `| \`${cell(r.session)}\` | ${r.model ? cell(r.model) : '—'} | ${r.costUsd === null ? '—' : `$${r.costUsd.toFixed(2)}`} | ${approvedCell(r.approved)} |`);
  const body = [
    MARKER,
    '### How this pull request was made',
    '',
    '| Conversation | Model | Estimated cost | Permissions approved |',
    '|---|---|---|---|',
    ...lines,
    '',
    "<sub>From [Orchia](https://github.com/MPoulhazan/orchia). Cost is Claude Code's estimate at list price. Permissions are the requests approved in Orchia: rules that already allowed a tool and answers typed in the terminal aren't counted.</sub>",
  ].join('\n');
  return redactSecrets(body);
}

export interface EvidenceSession {
  id: string;
  projectId: string;
  cwd: string;
  turns: number;
  row: EvidenceRow;
}

/** The open pull requests of the projects that turned this on, with the conversations of their folder. */
export function evidenceSources(sessions: EvidenceSession[], enabled: (projectId: string) => boolean, pullRequestOf: (cwd: string) => PullRequestState | null): EvidenceSource[] {
  const byUrl = new Map<string, EvidenceSource>();
  for (const s of sessions) {
    if (!s.turns || !enabled(s.projectId)) continue;
    const pr = pullRequestOf(s.cwd);
    if (pr?.state !== 'OPEN') continue;
    const source = byUrl.get(pr.url) ?? { url: pr.url, rows: [] };
    source.rows.push(s.row);
    byUrl.set(pr.url, source);
  }
  return [...byUrl.values()];
}

export type GhApi = (args: string[]) => Promise<string>;

const ghApi: GhApi = (args) =>
  new Promise((resolve, reject) => {
    execFile('gh', ['api', ...args], { timeout: 20_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });

interface Entry {
  /** Kept by conversation, so a closed session's line stays on the comment. */
  rows: Record<string, EvidenceRow>;
  /** What the comment says now. */
  body: string;
  at: number;
}

export class PrEvidencePublisher {
  private entries: Record<string, Entry> = {};
  private logins = new Map<string, string>();
  private busy = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sources: () => EvidenceSource[],
    private readonly gh: GhApi = ghApi,
    private readonly file = join(CONFIG_DIR, 'pr-evidence.json'),
  ) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved && typeof saved === 'object') this.entries = saved;
    } catch {}
  }

  start(everyMs = 60_000) {
    this.timer ??= setInterval(() => void this.tick(), everyMs);
    this.timer.unref?.();
  }

  async tick(now = Date.now()) {
    if (this.busy) return;
    this.busy = true;
    let changed = false;
    try {
      for (const source of this.sources()) {
        const entry = (this.entries[source.url] ??= { rows: {}, body: '', at: 0 });
        for (const row of source.rows) {
          if (JSON.stringify(entry.rows[row.session]) === JSON.stringify(row)) continue;
          entry.rows[row.session] = row;
          changed = true;
        }
        const rows = Object.values(entry.rows);
        if (!rows.length) continue;
        const body = evidenceBody(rows);
        if (body === entry.body || now - entry.at < MIN_UPDATE_MS) continue;
        entry.at = now;
        changed = true;
        try {
          await this.publish(source.url, body);
          entry.body = body;
        } catch {
          console.warn(`Could not update the evidence comment on ${source.url}. Trying again later.`);
        }
      }
      if (changed) this.save(now);
    } finally {
      this.busy = false;
    }
  }

  /** Edits the comment this account already posted, found again on GitHub, or posts the first one. */
  private async publish(url: string, body: string) {
    const match = url.match(/^https:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    if (!match) throw new Error('Not a pull request URL');
    const [, host, repo, number] = match;
    const on = host === 'github.com' ? [] : ['--hostname', host];
    // Only this account's: someone else could post a comment that starts with the marker.
    const login = await this.login(host, on);
    const found = await this.gh([...on, `repos/${repo}/issues/${number}/comments`, '--paginate', '--jq', `.[] | select((.body | startswith("${MARKER}")) and .user.login == "${login}") | .id`]);
    const id = found.split(/\s+/).find(Boolean);
    if (id) await this.gh([...on, '-X', 'PATCH', `repos/${repo}/issues/comments/${id}`, '-f', `body=${body}`]);
    else await this.gh([...on, `repos/${repo}/issues/${number}/comments`, '-f', `body=${body}`]);
  }

  private async login(host: string, on: string[]): Promise<string> {
    const known = this.logins.get(host);
    if (known) return known;
    const login = (await this.gh([...on, 'user', '--jq', '.login'])).trim();
    if (!/^[\w.\-[\]]+$/.test(login)) throw new Error('Unexpected GitHub login');
    this.logins.set(host, login);
    return login;
  }

  private save(now: number) {
    for (const [url, entry] of Object.entries(this.entries)) if (now - entry.at > KEEP_FOR_MS && entry.at) delete this.entries[url];
    try {
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.entries));
      renameSync(`${this.file}.tmp`, this.file);
    } catch (err) {
      console.error(`Could not save ${this.file}:`, err);
    }
  }
}

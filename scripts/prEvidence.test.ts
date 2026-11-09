import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { evidenceBody, evidenceSources, MARKER, MIN_UPDATE_MS, PrEvidencePublisher, type EvidenceRow, type EvidenceSession } from '../server/prEvidence.ts';
import type { PullRequestState } from '../server/pullRequests.ts';

const URL = 'https://github.com/acme/app/pull/12';
const row = (overrides: Partial<EvidenceRow> = {}): EvidenceRow => ({ session: '1a2b3c4d', model: 'claude-opus-5-5', costUsd: 1.234, approved: { Bash: 3, Edit: 1 }, ...overrides });
const file = () => join(mkdtempSync(join(tmpdir(), 'orchia-evidence-')), 'pr-evidence.json');

/** A fake gh: remembers comments like GitHub does, and every call it gets. */
function fakeGh(comments: { id: number; body: string; login: string }[] = []) {
  const calls: string[][] = [];
  let nextId = 100;
  const gh = async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'user') return 'me\n';
    if (args.includes('--paginate')) {
      return comments.filter((c) => c.body.startsWith(MARKER) && c.login === 'me').map((c) => `${c.id}\n`).join('');
    }
    const body = args.find((a) => a.startsWith('body='))!.slice(5);
    if (args.includes('PATCH')) comments.find((c) => args.includes(`repos/acme/app/issues/comments/${c.id}`))!.body = body;
    else comments.push({ id: nextId++, body, login: 'me' });
    return '';
  };
  return { gh, calls, comments };
}

test('the comment holds the conversation, model, cost and approved permissions', () => {
  const body = evidenceBody([row()]);
  assert.ok(body.startsWith(MARKER));
  assert.match(body, /\| `1a2b3c4d` \| claude-opus-5-5 \| \$1\.23 \| Bash ×3, Edit ×1 \|/);
});

test('unknown values show a dash, and no approval reads as none', () => {
  assert.match(evidenceBody([row({ model: null, costUsd: null, approved: {} })]), /\| `1a2b3c4d` \| — \| — \| — \|/);
});

test('a secret is masked and markup cannot break out of the table', () => {
  const token = `ghp_${'a1B2'.repeat(9)}`;
  const body = evidenceBody([row({ model: `model ${token}`, approved: { 'x|y<script>': 1 } })]);
  assert.equal(body.includes(token), false);
  assert.match(body, /ghp_…a1B2/);
  assert.equal(body.includes('<script>'), false);
  assert.equal(body.includes('x|y'), false);
});

const open: PullRequestState = { number: 12, title: 't', url: URL, state: 'OPEN', headSha: 'abc', mergedAt: null, reviewDecision: null, failed: [], pending: 0 };
const session = (overrides: Partial<EvidenceSession> = {}): EvidenceSession => ({ id: 's', projectId: 'p', cwd: '/w', turns: 2, row: row(), ...overrides });

test('nothing is published for a project that did not turn it on', () => {
  assert.deepEqual(evidenceSources([session()], () => false, () => open), []);
});

test('only open pull requests and conversations with a turn count', () => {
  assert.equal(evidenceSources([session()], () => true, () => open).length, 1);
  assert.deepEqual(evidenceSources([session()], () => true, () => ({ ...open, state: 'MERGED' })), []);
  assert.deepEqual(evidenceSources([session()], () => true, () => null), []);
  assert.deepEqual(evidenceSources([session({ turns: 0 })], () => true, () => open), []);
});

test('two conversations in a folder share one source', () => {
  const sources = evidenceSources([session(), session({ id: 'b', row: row({ session: 'bbbbbbbb' }) })], () => true, () => open);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].rows.length, 2);
});

test('the first publish creates one comment, and the same content is not sent again', async () => {
  const github = fakeGh();
  const publisher = new PrEvidencePublisher(() => [{ url: URL, rows: [row()] }], github.gh, file());
  await publisher.tick(1_000_000);
  assert.equal(github.comments.length, 1);
  const calls = github.calls.length;
  await publisher.tick(1_000_000 + MIN_UPDATE_MS * 2);
  assert.equal(github.calls.length, calls);
  assert.equal(github.comments.length, 1);
});

test('a change edits the same comment, not before the minimum delay', async () => {
  const github = fakeGh();
  let rows = [row()];
  const publisher = new PrEvidencePublisher(() => [{ url: URL, rows }], github.gh, file());
  await publisher.tick(1_000_000);
  rows = [row({ costUsd: 2 })];
  await publisher.tick(1_000_000 + 1000);
  assert.match(github.comments[0].body, /\$1\.23/);
  await publisher.tick(1_000_000 + MIN_UPDATE_MS);
  assert.equal(github.comments.length, 1);
  assert.match(github.comments[0].body, /\$2\.00/);
});

test('after a restart it finds its comment again on GitHub instead of posting a second one', async () => {
  const github = fakeGh([{ id: 7, body: `${MARKER}\nold`, login: 'me' }]);
  const publisher = new PrEvidencePublisher(() => [{ url: URL, rows: [row()] }], github.gh, file());
  await publisher.tick(1_000_000);
  assert.equal(github.comments.length, 1);
  assert.match(github.comments[0].body, /1a2b3c4d/);
});

test("someone else's comment with the marker is left alone", async () => {
  const github = fakeGh([{ id: 7, body: `${MARKER}\nspoofed`, login: 'stranger' }]);
  const publisher = new PrEvidencePublisher(() => [{ url: URL, rows: [row()] }], github.gh, file());
  await publisher.tick(1_000_000);
  assert.equal(github.comments[0].body, `${MARKER}\nspoofed`);
  assert.equal(github.comments.length, 2);
  assert.equal(github.calls.some((c) => c.includes('PATCH')), false);
});

test("a closed session's line stays, also after a restart", async () => {
  const github = fakeGh();
  const store = file();
  let rows = [row()];
  await new PrEvidencePublisher(() => [{ url: URL, rows }], github.gh, store).tick(1_000_000);
  rows = [row({ session: 'bbbbbbbb' })];
  await new PrEvidencePublisher(() => [{ url: URL, rows }], github.gh, store).tick(1_000_000 + MIN_UPDATE_MS);
  assert.equal(github.comments.length, 1);
  assert.match(github.comments[0].body, /1a2b3c4d/);
  assert.match(github.comments[0].body, /bbbbbbbb/);
});

test('a gh failure does not throw, and it tries again after the delay', async () => {
  const github = fakeGh();
  let failing = true;
  const gh = async (args: string[]) => {
    if (failing && args.some((a) => a.startsWith('body='))) throw new Error('offline');
    return github.gh(args);
  };
  const publisher = new PrEvidencePublisher(() => [{ url: URL, rows: [row()] }], gh, file());
  await publisher.tick(1_000_000);
  assert.equal(github.comments.length, 0);
  failing = false;
  await publisher.tick(1_000_000 + MIN_UPDATE_MS);
  assert.equal(github.comments.length, 1);
});

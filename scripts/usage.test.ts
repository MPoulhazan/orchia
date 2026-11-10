import assert from 'node:assert/strict';
import test from 'node:test';
import { addUsageLine, costOf, emptyUsage, localDay, priceOf, usageRows, type FileUsage } from '../server/usage.ts';

const AT = '2026-11-09T15:00:00.000Z';
const DAY = localDay(Date.parse(AT));

function reply(id: string, usage: object, opts: { model?: string; at?: string; type?: string } = {}) {
  return JSON.stringify({
    type: opts.type ?? 'assistant',
    timestamp: opts.at ?? AT,
    message: { id, model: opts.model ?? 'claude-opus-5-5', usage },
  });
}

function read(...lines: string[]): FileUsage {
  const usage = emptyUsage();
  for (const line of lines) addUsageLine(usage, line);
  return usage;
}

const U = { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 600 } };

test('a reply written once per content block is counted once', () => {
  const rows = usageRows([{ conversation: 'a', usage: read(reply('m1', U), reply('m1', U), reply('m2', U)) }], DAY);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].output, 400);
  assert.equal(rows[0].cacheRead, 10_000);
});

test('cache writes are split between the 1-hour and the 5-minute cache', () => {
  const [row] = usageRows([{ conversation: 'a', usage: read(reply('m1', U)) }], DAY);
  assert.equal(row.cacheWrite1h, 600);
  assert.equal(row.cacheWrite5m, 400);
});

test('a resumed conversation that carries earlier replies again does not count them twice', () => {
  const first = read(reply('m1', U));
  const resumed = read(reply('m1', U), reply('m2', U));
  const [row] = usageRows([{ conversation: 'a', usage: first }, { conversation: 'b', usage: resumed }], DAY);
  assert.equal(row.output, 400);
});

test('a subagent counts with its conversation', () => {
  const main = read(reply('m1', U));
  const agent = read(reply('m2', U));
  const [row] = usageRows([{ conversation: 'a', usage: main }, { conversation: 'a', usage: agent }], DAY);
  assert.equal(row.sessions, 1);
  assert.equal(row.output, 400);
});

test('rows are split by day and model, most recent day first', () => {
  const usage = read(reply('m1', U), reply('m2', U, { model: 'claude-sonnet-5-5' }), reply('m3', U, { at: '2026-11-10T15:00:00.000Z' }));
  const rows = usageRows([{ conversation: 'a', usage }], DAY);
  assert.deepEqual(
    rows.map((r) => [r.day, r.model]),
    [
      [localDay(Date.parse('2026-11-10T15:00:00.000Z')), 'claude-opus-5-5'],
      [DAY, 'claude-opus-5-5'],
      [DAY, 'claude-sonnet-5-5'],
    ],
  );
});

test('days before the window are left out', () => {
  const usage = read(reply('m1', U, { at: '2026-10-01T15:00:00.000Z' }), reply('m2', U));
  assert.deepEqual(usageRows([{ conversation: 'a', usage }], DAY).map((r) => r.day), [DAY]);
});

test('lines without usage, from the user, or from a synthetic model are skipped', () => {
  const usage = read(
    JSON.stringify({ type: 'user', timestamp: AT, message: { content: 'hello "usage"' } }),
    reply('m1', U, { model: '<synthetic>' }),
    reply('m2', U, { type: 'user' }),
    'not json "usage" "type":"assistant"',
  );
  assert.equal(usage.size, 0);
});

test('cost follows the list price, with cache writes at 1.25× and 2× input', () => {
  // Opus 5.5: $4 input, $20 output, $0.20 cache read.
  const usd = costOf('claude-opus-5-5', { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000 });
  assert.equal(usd, 4 + 20 + 0.2 + 5 + 8);
});

test('the longest model prefix wins, and a suffix like [1m] still finds the price', () => {
  assert.equal(priceOf('claude-opus-5-5')?.input, 4);
  assert.equal(priceOf('claude-opus-5')?.input, 5);
  assert.equal(priceOf('claude-opus-5-5[1m]')?.input, 4);
  assert.equal(priceOf('claude-sonnet-4-5-20250929'), null);
});

test('an unknown model keeps its tokens and has no cost', () => {
  const [row] = usageRows([{ conversation: 'a', usage: read(reply('m1', U, { model: 'some-other-model' })) }], DAY);
  assert.equal(row.costUsd, null);
  assert.equal(row.output, 200);
});

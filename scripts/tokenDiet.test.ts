import assert from 'node:assert/strict';
import test from 'node:test';
import { addLine, dietFindings, emptyFacts, HEAVY_MEMORY_BYTES, SETTLED_AFTER_MS, type DietInput, type TranscriptFacts } from '../server/tokenDiet.ts';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const OLD = NOW - SETTLED_AFTER_MS * 2;

function session(id: string, overrides: Partial<TranscriptFacts> = {}): TranscriptFacts {
  return { ...emptyFacts(id), lastAt: OLD, prompts: ['a prompt that is only here once ' + id], model: 'claude-opus-5-5', effort: 'medium', ...overrides };
}

const many = (n: number, overrides: Partial<TranscriptFacts> = {}) => Array.from({ length: n }, (_, i) => session(`s${i}`, overrides));

function ids(input: Partial<DietInput>): string[] {
  return dietFindings({ sessions: [], connectors: [], memoryFiles: [], now: NOW, ...input }).map((f) => f.id);
}

const sentry = { name: 'claude.ai Sentry', prefix: 'claude_ai_Sentry' };

test('a connected connector never called in enough sessions is reported', () => {
  assert.deepEqual(ids({ sessions: many(5), connectors: [sentry] }), ['unused-connectors']);
});

test('a connector called once is not reported', () => {
  const sessions = [...many(4), session('s4', { mcpTools: ['mcp__claude_ai_Sentry__search_issues'] })];
  assert.deepEqual(ids({ sessions, connectors: [sentry] }), []);
});

test('a connector is not judged on too few sessions', () => {
  assert.deepEqual(ids({ sessions: many(4), connectors: [sentry] }), []);
});

test('a heavy CLAUDE.md is reported with its size in tokens', () => {
  const [finding] = dietFindings({ sessions: [], connectors: [], now: NOW, memoryFiles: [{ label: 'CLAUDE.md', bytes: 32_000 }] });
  assert.equal(finding.id, 'heavy-memory:CLAUDE.md');
  assert.match(finding.detail, /32 KB, about 8,000 tokens/);
});

test('a CLAUDE.md under the limit is not reported', () => {
  assert.deepEqual(ids({ memoryFiles: [{ label: 'CLAUDE.md', bytes: HEAVY_MEMORY_BYTES - 1 }] }), []);
});

test('a session compacted automatically twice is reported', () => {
  assert.deepEqual(ids({ sessions: [session('a', { autoCompacts: 2 }), session('b')] }), ['auto-compacts']);
});

test('a session compacted automatically once is not reported', () => {
  assert.deepEqual(ids({ sessions: [session('a', { autoCompacts: 1 })] }), []);
});

test('several short sessions on Opus at max effort are reported', () => {
  assert.deepEqual(ids({ sessions: many(3, { effort: 'max' }) }), ['opus-max-short']);
});

test('max effort is not reported on long sessions, other models, too few sessions or a session just used', () => {
  const longPrompts = ['one', 'two', 'three', 'four'];
  assert.deepEqual(ids({ sessions: many(3, { effort: 'max', prompts: longPrompts }) }), []);
  assert.deepEqual(ids({ sessions: many(3, { effort: 'max', model: 'claude-sonnet-5-5' }) }), []);
  assert.deepEqual(ids({ sessions: many(2, { effort: 'max' }) }), []);
  assert.deepEqual(ids({ sessions: many(3, { effort: 'max', lastAt: NOW - 1000 }) }), []);
  assert.deepEqual(ids({ sessions: many(3, { effort: 'high' }) }), []);
});

test('the same prompt in three sessions is reported, whatever its case and spacing', () => {
  const sessions = [
    session('a', { prompts: ['Run the tests and fix them'] }),
    session('b', { prompts: ['run  the tests and FIX them'] }),
    session('c', { prompts: ['run the tests and fix them\n'] }),
  ];
  const [finding] = dietFindings({ sessions, connectors: [], memoryFiles: [], now: NOW });
  assert.equal(finding.title, 'Same prompt in 3 sessions');
  assert.equal(finding.detail, '"Run the tests and fix them"');
});

test('a prompt repeated too little, too short, inside one session or written by Orchia is not reported', () => {
  const twice = [session('a', { prompts: ['Run the tests and fix them'] }), session('b', { prompts: ['Run the tests and fix them'] })];
  assert.deepEqual(ids({ sessions: twice }), []);
  assert.deepEqual(ids({ sessions: many(3, { prompts: ['continue'] }) }), []);
  assert.deepEqual(ids({ sessions: [session('a', { prompts: Array(5).fill('Run the tests and fix them') })] }), []);
  assert.deepEqual(ids({ sessions: many(3, { prompts: ['Continue the plan with lot 2 of 7 only, then stop'] }) }), []);
});

test('a secret inside a repeated prompt is masked', () => {
  const token = `ghp_${'a1B2'.repeat(9)}`;
  const [finding] = dietFindings({ sessions: many(3, { prompts: [`deploy with ${token} please`] }), connectors: [], memoryFiles: [], now: NOW });
  assert.equal(finding.detail.includes(token), false);
  assert.match(finding.detail, /ghp_…a1B2/);
});

test('transcript lines are read into facts', () => {
  const facts = emptyFacts('t');
  const lines = [
    { type: 'user', timestamp: '2026-11-09T10:00:00Z', message: { content: 'Add a CSV export' }, origin: { kind: 'human' } },
    { type: 'user', timestamp: '2026-11-09T10:00:01Z', message: { content: [{ type: 'text', text: 'and a test' }, { type: 'image' }] } },
    { type: 'user', timestamp: '2026-11-09T10:00:02Z', message: { content: [{ type: 'tool_result', content: 'not a prompt' }] } },
    { type: 'user', timestamp: '2026-11-09T10:00:03Z', isMeta: true, message: { content: 'meta' } },
    { type: 'user', timestamp: '2026-11-09T10:00:04Z', isCompactSummary: true, message: { content: 'summary' } },
    { type: 'user', timestamp: '2026-11-09T10:00:05Z', message: { content: '<command-name>/clear</command-name>' } },
    { type: 'user', timestamp: '2026-11-09T10:00:06Z', origin: { kind: 'task-notification' }, message: { content: 'a task ended' } },
    { type: 'assistant', timestamp: '2026-11-09T10:01:00Z', effort: 'max', message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', name: 'mcp__github__get_me' }, { type: 'tool_use', name: 'Bash' }] } },
    { type: 'assistant', timestamp: '2026-11-09T10:01:30Z', message: { model: '<synthetic>', content: [] } },
    { type: 'system', subtype: 'compact_boundary', timestamp: '2026-11-09T10:02:00Z', compactMetadata: { trigger: 'auto' } },
    { type: 'system', subtype: 'compact_boundary', timestamp: '2026-11-09T10:03:00Z', compactMetadata: { trigger: 'manual' } },
  ];
  for (const line of lines) addLine(facts, JSON.stringify(line));
  addLine(facts, 'not json "type":"user"');
  assert.deepEqual(facts.prompts, ['Add a CSV export', 'and a test']);
  assert.deepEqual(facts.mcpTools, ['mcp__github__get_me']);
  assert.equal(facts.autoCompacts, 1);
  assert.equal(facts.model, 'claude-opus-5-5');
  assert.equal(facts.effort, 'max');
  assert.equal(facts.lastAt, Date.parse('2026-11-09T10:03:00Z'));
});

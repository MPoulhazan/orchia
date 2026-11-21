import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MISSED_AFTER_MS, ScheduleStore, parseScheduled, splitDated, titleOf } from '../server/schedule.ts';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 21, 15, 0);
const file = () => join(mkdtempSync(join(tmpdir(), 'orchia-schedule-')), 'schedule.json');
const input = (at: number, text = 'Check the first events') => ({ projectId: 'p1', title: titleOf(text), text, at, run: false });

test('an item waits until its time, then comes due once', () => {
  const store = new ScheduleStore(file(), NOW);
  const item = store.add(input(NOW + HOUR), NOW);
  assert.equal(item.state, 'waiting');
  assert.deepEqual(store.tick(NOW + HOUR - 1), []);
  assert.deepEqual(store.tick(NOW + HOUR).map((i) => i.id), [item.id]);
  assert.equal(store.get(item.id)?.state, 'due');
  assert.deepEqual(store.tick(NOW + 2 * HOUR), []);
});

test('an item scheduled in the past is due at once', () => {
  const store = new ScheduleStore(file(), NOW);
  assert.equal(store.add(input(NOW - HOUR), NOW).state, 'due');
});

test('what came due while Orchia was closed is missed; a quick restart keeps it due', () => {
  const path = file();
  const store = new ScheduleStore(path, NOW);
  const long = store.add(input(NOW + HOUR, 'Long ago'), NOW);
  const recent = store.add(input(NOW + 3 * HOUR, 'Just now'), NOW);
  const later = store.add(input(NOW + 5 * HOUR, 'Not yet'), NOW);
  // Orchia starts again a few minutes after `recent` was due.
  const reopened = new ScheduleStore(path, NOW + 3 * HOUR + MISSED_AFTER_MS / 2);
  assert.equal(reopened.get(long.id)?.state, 'missed');
  assert.equal(reopened.get(recent.id)?.state, 'waiting');
  assert.equal(reopened.get(later.id)?.state, 'waiting');
  assert.deepEqual(reopened.tick(NOW + 3 * HOUR + MISSED_AFTER_MS / 2).map((i) => i.id), [recent.id]);
});

test('a missed item is never made due again by the clock, only by a new date', () => {
  const path = file();
  const item = new ScheduleStore(path, NOW).add(input(NOW + HOUR), NOW);
  const reopened = new ScheduleStore(path, NOW + 5 * HOUR);
  assert.deepEqual(reopened.tick(NOW + 5 * HOUR), []);
  assert.equal(reopened.update(item.id, { at: NOW + 6 * HOUR }, NOW + 5 * HOUR)?.state, 'waiting');
});

test('the list is soonest first and kept across restarts', () => {
  const path = file();
  const store = new ScheduleStore(path, NOW);
  store.add(input(NOW + 2 * HOUR, 'B'), NOW);
  store.add(input(NOW + HOUR, 'A'), NOW);
  assert.deepEqual(new ScheduleStore(path, NOW).list().map((i) => i.title), ['A', 'B']);
});

test('removing a project removes its items', () => {
  const store = new ScheduleStore(file(), NOW);
  store.add(input(NOW + HOUR), NOW);
  store.add({ ...input(NOW + HOUR), projectId: 'p2' }, NOW);
  store.removeProject('p1');
  assert.deepEqual(store.list().map((i) => i.projectId), ['p2']);
});

test('the title is the first line of the prompt, without heading marks', () => {
  assert.equal(titleOf('\n### On 2026-12-01: Remove the export\n\nDelete the route.'), 'On 2026-12-01: Remove the export');
  assert.equal(titleOf('x'.repeat(300)).length, 120);
});

test('a request needs a prompt, a date and a project; run defaults to off', () => {
  assert.deepEqual(parseScheduled({ projectId: 'p1', text: ' Do it \r\nnow ', at: NOW }, false), { projectId: 'p1', text: 'Do it \nnow', title: 'Do it', at: NOW, run: false });
  assert.throws(() => parseScheduled({ projectId: 'p1', text: '  ', at: NOW }, false), /prompt/);
  assert.throws(() => parseScheduled({ projectId: 'p1', text: 'a', at: 'tomorrow' }, false), /date/);
  assert.throws(() => parseScheduled({ text: 'a', at: NOW }, false), /project/);
  assert.throws(() => parseScheduled({ projectId: 'p1', text: 'a', at: NOW, run: 'yes' }, false), /run/);
});

test('a change only touches what it names', () => {
  assert.deepEqual(parseScheduled({ at: NOW }, true), { at: NOW });
  assert.deepEqual(parseScheduled({ run: true }, true), { run: true });
});

const local = (y: number, mo: number, d: number, h = 9, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

test('dated headings become steps, with their text, at 09:00 unless a time is given', () => {
  const answer = [
    'The tracking change is live. The rest waits for real traffic:',
    '',
    '### On 2026-11-24: Check the first events',
    'Open the analytics report and confirm `lot_scheduled` events arrive.',
    '',
    '### On 2026-11-28 14:30: Compare reminders vs auto-runs',
    '- count runs',
    '- count skips',
    '',
    'Want me to start on lot 4 now?',
  ].join('\n');
  const steps = splitDated(answer)!;
  assert.deepEqual(steps.map((s) => s.title), ['Check the first events', 'Compare reminders vs auto-runs']);
  assert.deepEqual(steps.map((s) => s.at), [local(2026, 11, 24), local(2026, 11, 28, 14, 30)]);
  assert.equal(steps[0].text, 'Check the first events\n\nOpen the analytics report and confirm `lot_scheduled` events arrive.');
  // The closing question is not part of the last step.
  assert.equal(steps[1].text, 'Compare reminders vs auto-runs\n\n- count runs\n- count skips');
});

test('a single dated step counts; a heading without the strict form does not', () => {
  assert.equal(splitDated('## On 2026-12-05: Remove the export')?.length, 1);
  assert.equal(splitDated('### Next Monday: check the events'), null);
  assert.equal(splitDated('### On 05/12/2026: check'), null);
  assert.equal(splitDated('On 2026-12-05: not a heading'), null);
  assert.equal(splitDated('Nothing dated here.'), null);
});

test('an impossible date or time is not a step', () => {
  assert.equal(splitDated('### On 2026-02-31: Never'), null);
  assert.equal(splitDated('### On 2026-12-01 25:00: Never'), null);
});

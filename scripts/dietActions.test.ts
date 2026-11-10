import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DietActionStore } from '../server/dietActions.ts';

function withDir(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'orchia-diet-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a change is kept across a restart, so it can be undone later', () => {
  withDir((dir) => {
    new DietActionStore(dir).add({ projectId: 'p1', key: 'unused-connectors', names: ['claude.ai Sentry'], at: 1 });
    assert.deepEqual(new DietActionStore(dir).get('p1', 'unused-connectors')?.names, ['claude.ai Sentry']);
  });
});

test('a second change to the same finding adds to the first, so one undo brings all back', () => {
  withDir((dir) => {
    const store = new DietActionStore(dir);
    store.add({ projectId: 'p1', key: 'unused-connectors', names: ['a', 'b'], at: 1 });
    store.add({ projectId: 'p1', key: 'unused-connectors', names: ['b', 'c'], at: 2 });
    assert.deepEqual(store.get('p1', 'unused-connectors'), { projectId: 'p1', key: 'unused-connectors', names: ['a', 'b', 'c'], at: 2 });
    assert.equal(store.list().length, 1);
  });
});

test('undoing forgets the change, and removed projects take theirs with them', () => {
  withDir((dir) => {
    const store = new DietActionStore(dir);
    store.add({ projectId: 'p1', key: 'unused-connectors', names: ['a'], at: 1 });
    store.add({ projectId: 'p2', key: 'unused-connectors', names: ['a'], at: 1 });
    store.remove('p1', 'unused-connectors');
    store.keepProjects(new Set(['p3']));
    assert.deepEqual(new DietActionStore(dir).list(), []);
  });
});

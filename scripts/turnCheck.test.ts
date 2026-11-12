import assert from 'node:assert/strict';
import test from 'node:test';
import { STUCK_AFTER, TurnChecks, checksIn, closingQuestion, shellFailed } from '../server/turnCheck.ts';

test('checksIn names the checks a command runs', () => {
  assert.deepEqual(checksIn('npm test'), ['tests']);
  assert.deepEqual(checksIn('npm run typecheck && npm test'), ['types', 'tests']);
  assert.deepEqual(checksIn('npx tsc --noEmit'), ['types']);
  assert.deepEqual(checksIn('npm run build'), ['build']);
  assert.deepEqual(checksIn('git add -A && git commit -m x && git push'), ['push']);
  assert.deepEqual(checksIn('node --import tsx --test scripts/a.test.ts'), ['tests']);
  assert.deepEqual(checksIn('ls -la'), []);
  assert.deepEqual(checksIn('git status'), []);
});

test('shellFailed reads an error exit from the tool response', () => {
  assert.equal(shellFailed({ stdout: 'ok', stderr: '' }), false);
  assert.equal(shellFailed({ exitCode: 1 }), true);
  assert.equal(shellFailed({ interrupted: true }), true);
  assert.equal(shellFailed(undefined), false);
});

test('the last run of a check counts', () => {
  const t = new TurnChecks();
  t.record('npm test', false);
  t.record('npx tsc --noEmit', true);
  t.record('npm test', true);
  assert.deepEqual(t.list(), [
    { kind: 'tests', ok: true },
    { kind: 'types', ok: true },
  ]);
});

test('the same command failing again and again looks stuck, until it passes', () => {
  const t = new TurnChecks();
  for (let i = 1; i < STUCK_AFTER; i++) assert.equal(t.record('npm test', false), false);
  assert.equal(t.record('npm test', false), true);
  assert.equal(t.stuck, '`npm test` failed 3 times');
  // Another command failing doesn't clear it.
  t.record('ls nope', false);
  assert.ok(t.stuck);
  assert.equal(t.record('npm  test', true), true);
  assert.equal(t.stuck, null);
  t.reset();
  assert.deepEqual(t.list(), []);
});

test('closingQuestion finds the question a reply ends on', () => {
  assert.equal(
    closingQuestion('Token diet lists each connector.\n\nThe tests pass. Want me to push to **main**, or keep it on the branch?'),
    'Want me to push to main, or keep it on the branch?',
  );
  assert.equal(closingQuestion('Done. All tests pass.'), null);
  // A question earlier in the reply doesn't count.
  assert.equal(closingQuestion('Why did it fail? The date was parsed in UTC.\n\nFixed it, tests pass.'), null);
  // Nor one inside code.
  assert.equal(closingQuestion('Here it is:\n\n```js\nconst a = b ? c : d?\n```'), null);
  assert.equal(closingQuestion('Two options:\n\n- Keep it\n- Drop it\n\nWhich one do you prefer?'), 'Which one do you prefer?');
  assert.equal(closingQuestion(undefined), null);
});

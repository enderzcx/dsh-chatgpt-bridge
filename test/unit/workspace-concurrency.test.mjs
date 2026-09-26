import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WorkspaceConcurrencyGuard } from '../../lib/workspace-guard.js';

function tempGitRepo(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bridge-workspace-guard-'));
  const resolvedRoot = resolve(root);
  assert.ok(resolvedRoot.startsWith(resolve(tmpdir())));
  t.after(() => rmSync(resolvedRoot, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: resolvedRoot, stdio: 'pipe' });
  git('init');
  git('config', 'user.email', 'workspace-guard@example.invalid');
  git('config', 'user.name', 'Workspace Guard Test');
  writeFileSync(join(resolvedRoot, 'tracked.txt'), 'baseline\n');
  git('add', 'tracked.txt');
  git('commit', '-m', 'baseline');
  return { root: resolvedRoot, git };
}

test('R4 / A07: Workspace concurrency guard allows only one mutable session per workspace', () => {
  const guard = new WorkspaceConcurrencyGuard();
  const workspacePath = 'D:/test-workspace';

  const first = guard.acquireMutableLock(workspacePath, 'session-1', 'goal-1');
  assert.equal(first.success, true);
  assert.equal(first.holder?.sessionId, 'session-1');

  // Second mutable session is blocked
  const second = guard.acquireMutableLock(workspacePath, 'session-2', 'goal-2');
  assert.equal(second.success, false);
  assert.equal(second.holder?.sessionId, 'session-1');

  // Override allows second session with warning
  const override = guard.acquireMutableLock(workspacePath, 'session-2', 'goal-2', true, true);
  assert.equal(override.success, true);
  assert.ok(override.warning?.includes('session-1'));

  // Old overridden session attempting to release does not release session-2's lock
  assert.equal(guard.releaseLock('session-1'), false);
  assert.equal(guard.getLock(workspacePath)?.sessionId, 'session-2');

  // Releasing lock makes workspace available
  assert.equal(guard.releaseLock('session-2'), true);
  const third = guard.acquireMutableLock(workspacePath, 'session-3', 'goal-3');
  assert.equal(third.success, true);
});

test('R4 / A07: Workspace drift detection catches uncommitted tracked-file changes', async (t) => {
  const { root } = tempGitRepo(t);
  const guard = new WorkspaceConcurrencyGuard();
  const baseline = await guard.captureBaseline(root);
  writeFileSync(join(root, 'tracked.txt'), 'changed without a commit\n');

  const drift = await guard.detectDrift(root, baseline, 'session-release');
  assert.equal(drift.drifted, true);
  assert.ok(drift.details?.includes('working tree/index fingerprint changed'));
});

test('R4 / A07: Workspace drift detection attributes committed HEAD changes across sessions', async (t) => {
  const { root, git } = tempGitRepo(t);
  const guard = new WorkspaceConcurrencyGuard();
  const baseline = await guard.captureBaseline(root);

  guard.recordMutation(root, {
    sessionId: 'session-fix',
    goalId: 'goal-fix',
    type: 'commit',
    details: 'created new commit',
  });
  writeFileSync(join(root, 'tracked.txt'), 'committed change\n');
  git('add', 'tracked.txt');
  git('commit', '-m', 'change head');

  const drift = await guard.detectDrift(root, baseline, 'session-release');
  assert.equal(drift.drifted, true);
  assert.equal(drift.originatingSessionId, 'session-fix');
  assert.ok(drift.details?.includes('session-fix'));
});

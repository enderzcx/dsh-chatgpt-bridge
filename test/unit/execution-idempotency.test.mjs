import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionIdempotencyManager, idempotencyKindFor } from '../../lib/execution-idempotency.js';

test('R7 / A10: Repeated test suite with identical fingerprint returns SKIPPED_ALREADY_VERIFIED', () => {
  const manager = new ExecutionIdempotencyManager();
  const step = {
    kind: 'test',
    command: 'npm test',
    workspacePath: 'D:/workspace/repo',
    headSha: 'a1b2c3d4e5f6',
  };

  const fp = manager.computeFingerprint(step);
  assert.equal(manager.check(fp), null);

  // Record successful 203/203 PASS
  const evidence = manager.recordSuccess(fp, {
    kind: 'test',
    status: 'passed',
    summary: '203/203 tests passed',
    details: { total: 203, pass: 203, fail: 0 },
  });
  assert.ok(evidence.evidenceId);

  // Subsequent check returns idempotency hit
  const check = manager.check(fp);
  assert.ok(check);
  assert.equal(check.isIdempotent, true);
  assert.equal(check.code, 'SKIPPED_ALREADY_VERIFIED');
  assert.equal(check.evidenceId, evidence.evidenceId);
});

test('R8 / A11: Repeated publish operation returns SKIPPED_ALREADY_APPLIED', () => {
  const manager = new ExecutionIdempotencyManager();
  const step = {
    kind: 'npm_publish',
    command: 'npm publish',
    workspacePath: 'D:/workspace/repo',
    headSha: 'a1b2c3d4e5f6',
    extra: { package: 'probemux@0.1.0' },
  };

  const fp = manager.computeFingerprint(step);
  manager.recordSuccess(fp, {
    kind: 'npm_publish',
    status: 'applied',
    summary: 'probemux@0.1.0 published',
  });

  const check = manager.check(fp);
  assert.ok(check);
  assert.equal(check.isIdempotent, true);
  assert.equal(check.code, 'SKIPPED_ALREADY_APPLIED');
});

test('Fingerprint changes when Git HEAD or command changes', () => {
  const manager = new ExecutionIdempotencyManager();
  const fp1 = manager.computeFingerprint({
    kind: 'test',
    command: 'npm test',
    workspacePath: 'D:/workspace/repo',
    headSha: 'sha-1',
  });

  const fp2 = manager.computeFingerprint({
    kind: 'test',
    command: 'npm test',
    workspacePath: 'D:/workspace/repo',
    headSha: 'sha-2', // new commit
  });

  assert.notEqual(fp1, fp2);
});

test('Fingerprint changes when the dirty workspace or runtime identity changes without a new HEAD', () => {
  const manager = new ExecutionIdempotencyManager();
  const base = {
    kind: 'test',
    command: 'npm test',
    workspacePath: 'D:/workspace/repo',
    headSha: 'same-head',
  };
  const clean = manager.computeFingerprint({
    ...base,
    extra: { workspace_fingerprint: 'clean', node: '24.18.1', platform: 'win32', arch: 'x64' },
  });
  const dirty = manager.computeFingerprint({
    ...base,
    extra: { workspace_fingerprint: 'dirty-v2', node: '24.18.1', platform: 'win32', arch: 'x64' },
  });
  const otherRuntime = manager.computeFingerprint({
    ...base,
    extra: { workspace_fingerprint: 'clean', node: '22.23.2', platform: 'win32', arch: 'x64' },
  });

  assert.notEqual(clean, dirty);
  assert.notEqual(clean, otherRuntime);
});

test('ExecutionIdempotencyManager enforces FIFO cap on evidence cache', () => {
  const manager = new ExecutionIdempotencyManager(3);
  manager.recordSuccess('fp-1', { kind: 'test', status: 'passed' });
  manager.recordSuccess('fp-2', { kind: 'test', status: 'passed' });
  manager.recordSuccess('fp-3', { kind: 'test', status: 'passed' });
  assert.equal(manager.listEvidence().length, 3);
  assert.ok(manager.check('fp-1'));

  // 4th insertion evicts fp-1
  manager.recordSuccess('fp-4', { kind: 'test', status: 'passed' });
  assert.equal(manager.listEvidence().length, 3);
  assert.equal(manager.check('fp-1'), null);
  assert.ok(manager.check('fp-2'));
  assert.ok(manager.check('fp-4'));
});

test('compound test payload is not classified as reusable test evidence', () => {
  assert.equal(idempotencyKindFor('bash', 'npm test && curl https://example.invalid'), undefined);
  assert.equal(idempotencyKindFor('bash', 'npm publish && curl https://example.invalid'), undefined);
  assert.equal(idempotencyKindFor('cmd', 'npm test %DSH_INJECT%'), undefined);
  assert.equal(idempotencyKindFor('bash', 'npm test'), 'test');
});

test('evidence can be listed by the sessions that recorded or reused it', () => {
  const manager = new ExecutionIdempotencyManager();
  manager.recordSuccess('fp-session', {
    kind: 'test',
    sessionId: 'session-a',
    workspacePath: 'D:/workspace/repo',
  });
  assert.equal(manager.listEvidence({ sessionId: 'session-a' }).length, 1);
  assert.equal(manager.listEvidence({ sessionId: 'session-b' }).length, 0);

  assert.ok(manager.check('fp-session', { sessionId: 'session-b', workspacePath: 'D:/workspace/repo' }));
  assert.equal(manager.listEvidence({ sessionId: 'session-b' }).length, 1);
});

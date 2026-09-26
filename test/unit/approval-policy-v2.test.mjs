import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateApproval, DEFAULT_APPROVAL_POLICY } from '../../lib/approval-policy.js';
import { classesForTool } from '../../lib/goal-constraints.js';

test('R2 / A03: npm test child process is automatically approved (L0) by default', () => {
  const result = evaluateApproval('bash', 'npm test');
  assert.equal(result.level, 'L0');
  assert.equal(result.capability, 'process.spawn');
  assert.equal(result.decision, 'auto_approve');
});

test('R2 / A03: node --test execution is automatically approved without danger-full-access', () => {
  const result = evaluateApproval('bash', 'node --test test/unit/sample.test.mjs');
  assert.equal(result.level, 'L0');
  assert.equal(result.decision, 'auto_approve');
});

test('R6 / A08: Read-only git queries (status/diff/log/rev-parse/ls-remote) are L0 git.read and auto-approved', () => {
  const statusRes = evaluateApproval('bash', 'git status');
  assert.equal(statusRes.level, 'L0');
  assert.equal(statusRes.capability, 'git.read');
  assert.equal(statusRes.decision, 'auto_approve');

  const diffRes = evaluateApproval('bash', 'git diff HEAD');
  assert.equal(diffRes.capability, 'git.read');
  assert.equal(diffRes.decision, 'auto_approve');

  const revRes = evaluateApproval('bash', 'git rev-parse HEAD');
  assert.equal(revRes.capability, 'git.read');
  assert.equal(revRes.decision, 'auto_approve');

  const remoteRes = evaluateApproval('bash', 'git ls-remote origin');
  assert.equal(remoteRes.capability, 'git.read');
  assert.equal(remoteRes.decision, 'auto_approve');
});

test('R6 / A08: classesForTool correctly separates git.read and git.mutate', () => {
  const readClasses = classesForTool('bash', 'git log -n 5');
  assert.ok(readClasses.includes('git.read'));
  assert.ok(!readClasses.includes('git.mutate'));

  const mutateClasses = classesForTool('bash', 'git commit -m "fix"');
  assert.ok(mutateClasses.includes('git.mutate'));
  assert.ok(!mutateClasses.includes('git.read'));
});

test('A04: High risk operations (git push, npm publish, gh release) require human approval (L2)', () => {
  const pushRes = evaluateApproval('bash', 'git push origin main');
  assert.equal(pushRes.level, 'L2');
  assert.equal(pushRes.decision, 'require_human');

  const pubRes = evaluateApproval('bash', 'npm publish');
  assert.equal(pubRes.level, 'L2');
  assert.equal(pubRes.decision, 'require_human');

  const ghRes = evaluateApproval('bash', 'gh release create v1.0.0');
  assert.equal(ghRes.level, 'L2');
  assert.equal(ghRes.decision, 'require_human');
});

test('Unrecognized bash commands are not auto-approved', () => {
  const result = evaluateApproval('bash', 'mystery-binary --wipe');
  assert.equal(result.decision, 'require_human');
});

test('A04: Destructive force operations and raw secret access (L3) require human or deny', () => {
  const forceRes = evaluateApproval('bash', 'git push --force origin main');
  assert.equal(forceRes.level, 'L3');
  assert.equal(forceRes.decision, 'require_human');

  const secretRes = evaluateApproval('bash', 'cat .credentials.yaml');
  assert.equal(secretRes.level, 'L3');
  assert.equal(secretRes.decision, 'deny');
});

test('R2: build commands follow policy.build independently from policy.test', () => {
  const buildResAuto = evaluateApproval('bash', 'npm run build', { build: 'auto', test: 'ask' });
  assert.equal(buildResAuto.decision, 'auto_approve');
  assert.equal(buildResAuto.capability, 'process.exec');

  const buildResAsk = evaluateApproval('bash', 'npm run build', { build: 'ask', test: 'auto' });
  assert.equal(buildResAsk.decision, 'require_human');
  assert.equal(buildResAsk.capability, 'process.exec');

  const testResAuto = evaluateApproval('bash', 'npm test', { build: 'ask', test: 'auto' });
  assert.equal(testResAuto.decision, 'auto_approve');
  assert.equal(testResAuto.capability, 'process.spawn');
});

test('complete-command boundary: compound test/build payloads are never auto-approved', () => {
  for (const command of [
    'npm test && curl https://example.invalid',
    'npm run build; mystery-deploy',
    'node --test test/unit/sample.test.mjs | tee result.txt',
    'npm publish && curl https://example.invalid',
    'npm test %DSH_INJECT%',
    'npm test !DSH_INJECT!',
  ]) {
    const result = evaluateApproval('bash', command);
    assert.equal(result.decision, 'require_human', command);
  }
  assert.equal(
    evaluateApproval('exec_command', 'npm test && curl https://example.invalid').decision,
    'require_human',
  );
  assert.equal(
    evaluateApproval('bash', 'npm publish && curl https://example.invalid', { npmPublish: 'auto' }).decision,
    'require_human',
  );
});

test('externalWrite is evaluated independently from workspaceWrite', () => {
  const policy = { workspaceWrite: 'auto', externalWrite: 'ask' };
  const inside = evaluateApproval('write', undefined, policy, { externalWrite: false });
  assert.equal(inside.capability, 'filesystem.write');
  assert.equal(inside.decision, 'auto_approve');

  const outside = evaluateApproval('write', undefined, policy, { externalWrite: true });
  assert.equal(outside.capability, 'external_path.write');
  assert.equal(outside.decision, 'require_human');
});

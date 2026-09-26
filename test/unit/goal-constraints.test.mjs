import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldGoalFacts } from '../../lib/goal-facts.js';
import {
  classesForTool,
  countWorkspaceScans,
  defaultConstraintsForMode,
  evaluateConstraint,
  findConstraintViolation,
  mergeConstraints,
  parseExecutionMode,
} from '../../lib/goal-constraints.js';

const ev = (type, data, seq) => ({ type, seq, time: seq, data });
const toolCall = (seq, callId, name, args) =>
  ev('tool/call', { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) }, seq);
const toolResult = (seq, callId, { isError = false, content = 'ok' } = {}) =>
  ev('tool/result', {
    turn: 1,
    step: 1,
    message: { source: { callId }, content: [{ type: 'tool', isError, content }] },
  }, seq);

test('omitted execution_mode is standard; minimal tightens scan/writes', () => {
  assert.equal(parseExecutionMode(undefined), 'standard');
  assert.deepEqual(defaultConstraintsForMode('standard'), {});
  assert.deepEqual(defaultConstraintsForMode('minimal'), {
    allow_workspace_scan: false,
    max_changed_files: 0,
  });
  const merged = mergeConstraints(
    defaultConstraintsForMode('minimal'),
    { read_only: true, allow_workspace_scan: true, max_changed_files: 10 },
  );
  assert.equal(merged.allow_workspace_scan, false);
  assert.equal(merged.max_changed_files, 0);
  assert.equal(merged.read_only, true);
});

test('Test 3 — minimal 35s smoke: sleep is allowed, workspace scan count stays 0', () => {
  const constraints = defaultConstraintsForMode('minimal');
  const sleep = evaluateConstraint({
    constraints,
    toolName: 'bash',
    command: 'Start-Sleep -Seconds 35',
  });
  assert.equal(sleep.allow, true);

  const scan = evaluateConstraint({
    constraints,
    toolName: 'bash',
    command: 'Get-ChildItem -Recurse | Measure-Object',
  });
  assert.equal(scan.allow, false);
  assert.equal(scan.reason, 'workspace_scan_forbidden');

  const events = [
    toolCall(1, 'c1', 'bash', { command: 'Start-Sleep -Seconds 35' }),
    toolResult(2, 'c1'),
  ];
  assert.equal(countWorkspaceScans(foldGoalFacts(events)), 0);
});

test('Test 4 — allow_workspace_scan=false rejects classified scan', () => {
  const decision = evaluateConstraint({
    constraints: { allow_workspace_scan: false },
    toolName: 'glob',
    command: undefined,
  });
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, 'workspace_scan_forbidden');
  assert.equal(decision.action_class, 'filesystem.scan');
});

test('Test 5 — read_only rejects write tools', () => {
  const write = evaluateConstraint({
    constraints: { read_only: true },
    toolName: 'write',
    command: undefined,
  });
  assert.equal(write.allow, false);
  assert.equal(write.reason, 'read_only');

  const bashWrite = evaluateConstraint({
    constraints: { read_only: true },
    toolName: 'bash',
    command: 'Set-Content -Path note.txt -Value hello',
  });
  assert.equal(bashWrite.allow, false);
  assert.equal(bashWrite.reason, 'read_only');

  const read = evaluateConstraint({
    constraints: { read_only: true },
    toolName: 'read',
  });
  assert.equal(read.allow, true);
});

test('Test 6 — max_changed_files=1 fail-closes the second write', () => {
  const first = evaluateConstraint({
    constraints: { max_changed_files: 1 },
    changedFileCount: 0,
    toolName: 'write',
  });
  assert.equal(first.allow, true);

  const second = evaluateConstraint({
    constraints: { max_changed_files: 1 },
    changedFileCount: 1,
    toolName: 'write',
  });
  assert.equal(second.allow, false);
  assert.equal(second.reason, 'max_changed_files');
});

test('Test 10 — completed git tag / push are not replayed', () => {
  const tag = evaluateConstraint({
    constraints: {},
    completedKinds: ['git_tag', 'git_push'],
    toolName: 'bash',
    command: 'git tag -a v0.3.0 -m v0.3.0',
  });
  assert.equal(tag.allow, false);
  assert.equal(tag.reason, 'no_destructive_replay');
  assert.equal(tag.kind, 'git_tag');

  const release = evaluateConstraint({
    constraints: {},
    completedKinds: ['git_tag', 'git_push'],
    toolName: 'bash',
    command: 'gh release create v0.3.0',
  });
  assert.equal(release.allow, true);
});

test('post-hoc violation finder reports a successful forbidden scan', () => {
  const events = [
    toolCall(1, 'c1', 'bash', { command: 'Get-ChildItem -Recurse' }),
    toolResult(2, 'c1'),
  ];
  const found = findConstraintViolation(foldGoalFacts(events), { allow_workspace_scan: false });
  assert.ok(found);
  assert.equal(found.decision.reason, 'workspace_scan_forbidden');
});

test('constraints cannot raise permissions: read_only=false is a no-op', () => {
  const merged = mergeConstraints({ read_only: true }, { read_only: false });
  assert.equal(merged.read_only, true);
});

test('pwsh is classified as process.exec', () => {
  const classes = classesForTool('pwsh', 'Start-Sleep -Seconds 1');
  assert.ok(classes.includes('process.exec'));
});

test('forbidden process.exec rejects pwsh before execution', () => {
  const decision = evaluateConstraint({
    constraints: { forbidden_actions: ['process.exec'] },
    toolName: 'pwsh',
    command: 'Start-Sleep -Seconds 1',
  });
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, 'forbidden_action');
  assert.equal(decision.action_class, 'process.exec');
});

test('powershell / cmd / bash / shell stay classified as process.exec', () => {
  for (const name of ['powershell', 'cmd', 'bash', 'shell']) {
    assert.ok(
      classesForTool(name, 'Start-Sleep -Seconds 1').includes('process.exec'),
      `${name} must remain process.exec`,
    );
  }
});

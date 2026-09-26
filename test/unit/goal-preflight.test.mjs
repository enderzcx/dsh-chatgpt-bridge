import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGoalPreflight } from '../../lib/goal-preflight.js';

test('R3 / A06: Goal requires edit/commit while constraints specify read_only', () => {
  const result = validateGoalPreflight({
    goal: 'Fix the failing tests in probe module and commit changes',
    constraints: { read_only: true },
  });

  assert.equal(result.valid, false);
  assert.ok(result.conflicts.length >= 2);
  assert.ok(result.conflicts.some((c) => c.includes('read_only')));
  assert.ok(result.suggested_constraint_delta?.some((d) => d.includes('read_only=false')));
});

test('R3 / A06: Goal requires git mutate when git.mutate is in forbidden_actions', () => {
  const result = validateGoalPreflight({
    goal: 'Create git tag v1.0.0 and push branch',
    constraints: { forbidden_actions: ['git.mutate'] },
  });

  assert.equal(result.valid, false);
  assert.ok(result.conflicts.some((c) => c.includes('git.mutate')));
});

test('R3 / A06: Goal requires npm publish when npm.publish is forbidden', () => {
  const result = validateGoalPreflight({
    goal: 'Publish package to npm registry',
    constraints: { forbidden_actions: ['npm.publish'] },
  });

  assert.equal(result.valid, false);
  assert.ok(result.conflicts.some((c) => c.includes('npm.publish')));
});

test('R3 / A06: Writing outside the workspace without external_path.write is invalid', () => {
  const result = validateGoalPreflight({
    goal: 'Write a report outside the workspace using an external path',
    constraints: { forbidden_actions: ['external_path.write'] },
  });
  assert.equal(result.valid, false);
  assert.ok(result.conflicts.some((c) => c.includes('external_path.write')));
});

test('R3 / A06: Valid read-only goal passes preflight without conflicts', () => {
  const result = validateGoalPreflight({
    goal: 'Audit repository status, check git log and review package manifest',
    constraints: { read_only: true },
  });

  assert.equal(result.valid, true);
  assert.equal(result.conflicts.length, 0);
});

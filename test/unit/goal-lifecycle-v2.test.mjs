import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGoalSemanticallyEqual, createGoalRecord, applyRevision } from '../../lib/goal-control.js';

test('R1 / A01: Goal deduplication - identical goal/plan/constraints are recognized as equal', () => {
  const record = createGoalRecord({
    sessionId: 'session-1',
    goal: 'Run test and build project',
    plan: '1. npm test\n2. npm run build',
    mode: 'standard',
  });

  // Same goal and plan
  assert.equal(
    isGoalSemanticallyEqual(record, 'Run test and build project', '1. npm test\n2. npm run build'),
    true,
  );

  // Whitespace trimmed equality
  assert.equal(
    isGoalSemanticallyEqual(record, '  Run test and build project  \n', '1. npm test\n2. npm run build\n'),
    true,
  );

  // Different goal
  assert.equal(
    isGoalSemanticallyEqual(record, 'Different goal target', '1. npm test'),
    false,
  );
});

test('A02: applyRevision increments revision when goal semantics change', () => {
  const record = createGoalRecord({
    sessionId: 'session-1',
    goal: 'Initial Goal',
  });
  assert.equal(record.revision, 1);

  const revised = applyRevision(record, {
    goal: 'Updated Goal',
    revisionReason: 'user_modified_goal',
  }, 'goal_revised');

  assert.equal(revised.revision, 2);
  assert.equal(revised.revisions.length, 2);
  assert.equal(revised.revisions[1].goal, 'Updated Goal');
});

test('A02: applyRevision enforces optimistic locking with expectedRevision', () => {
  const record = createGoalRecord({
    sessionId: 'session-1',
    goal: 'Initial Goal',
  });

  // Matching expected revision succeeds
  const rev2 = applyRevision(record, {
    goal: 'Updated Goal',
    expectedRevision: 1,
  }, 'goal_revised');
  assert.equal(rev2.revision, 2);

  // Mismatched expected revision throws REVISION_CONFLICT
  assert.throws(
    () => applyRevision(rev2, {
      goal: 'Conflicting Goal',
      expectedRevision: 1, // Current is 2
    }, 'goal_revised'),
    /REVISION_CONFLICT/,
  );
});

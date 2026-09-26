import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGoalRecord, applyRevision } from '../../lib/goal-control.js';

test('R9 / A09: Resume continues from checkpoint and preserves completed actions', () => {
  const record = createGoalRecord({
    sessionId: 'session-resume',
    goal: 'Tag and publish the package',
    plan: '1. git tag v0.5.0\n2. npm publish',
  });

  // Turn 1 completes the tag step and defers publication.
  const revised1 = applyRevision(record, {
    completedActionKinds: ['git_tag'],
    deferredStepIds: ['npm_publish'],
    revisionReason: 'step_progress',
  }, 'goal_revised');

  assert.equal(revised1.revision, 2);
  assert.ok(revised1.completed_action_kinds.includes('git_tag'));
  assert.ok(revised1.deferred_step_ids.includes('npm_publish'));

  // Pause and Resume
  const resumed = applyRevision(revised1, {
    resumeStepIds: ['npm_publish'],
    revisionReason: 'user_resumed_goal',
  }, 'goal_resumed');

  assert.equal(resumed.revision, 3);
  assert.ok(resumed.completed_action_kinds.includes('git_tag'));
  // Resumed step is reactivated (un-deferred) without losing completed records
  assert.equal(resumed.deferred_step_ids.length, 0);
});

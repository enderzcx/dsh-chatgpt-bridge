import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGoalRecord, pruneBlockers } from '../../lib/goal-control.js';

test('R10 / A12: Succeeded actions automatically prune stale blockers', () => {
  const record = createGoalRecord({
    sessionId: 'session-blocker',
    goal: 'Test and publish',
  });

  record.active_blockers = [
    { step_id: 'npm_publish', reason: 'constraint_rejected', seq: 1 },
    { step_id: 'git_push', reason: 'network_error', seq: 2 },
  ];

  assert.equal(record.active_blockers.length, 2);

  // npm_publish succeeds on retry
  pruneBlockers(record, ['npm_publish']);

  assert.equal(record.active_blockers.length, 1);
  assert.equal(record.active_blockers[0].step_id, 'git_push');

  // git_push succeeds
  pruneBlockers(record, ['git_push']);
  assert.equal(record.active_blockers.length, 0);
});

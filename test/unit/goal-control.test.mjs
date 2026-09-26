import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GoalControlStore,
  HISTORY_PERSIST_MAX,
  HISTORY_WIRE_MAX,
  appendGoalEvent,
  applyNativeGetGoalResult,
  applyRevision,
  createGoalRecord,
  memoryStoreIo,
  parseGoalRecord,
  sliceHistory,
  supervisionGoal,
} from '../../lib/goal-control.js';

test('Test 1 — revision 1 is preserved when updating to revision 2', () => {
  const first = createGoalRecord({
    sessionId: 'session-1',
    goal: 'publish v0.3.0:\n- npm publish\n- GitHub Release',
    plan: 'tag then fork',
    now: 1_700_000_000_000,
  });
  assert.equal(first.revision, 1);
  assert.equal(first.revisions.length, 1);
  assert.equal(first.revisions[0].goal, first.goal);
  assert.equal(first.history[0].type, 'goal_created');

  const second = applyRevision(first, {
    goal: 'defer npm, continue GitHub Release',
    deferredStepIds: ['npm_publish'],
    revisionReason: 'user_modified_goal',
    now: 1_700_000_100_000,
  }, 'goal_revised');

  assert.equal(second.revision, 2);
  assert.equal(second.revisions.length, 2);
  assert.equal(second.revisions[0].revision, 1);
  assert.match(second.revisions[0].goal, /npm publish/);
  assert.equal(second.revisions[1].revision, 2);
  assert.equal(second.revisions[1].previous_revision, 1);
  assert.equal(second.goal, 'defer npm, continue GitHub Release');
  assert.deepEqual(second.deferred_step_ids, ['npm_publish']);
  assert.ok(second.history.some((event) => event.type === 'goal_revised'));
  assert.ok(second.history.some((event) => event.type === 'step_deferred' && event.step_id === 'npm_publish'));

  const view = supervisionGoal(second);
  assert.equal(view.goal_id, 'goal-session-1');
  assert.equal(view.revision, 2);
  assert.equal(view.previous_revision, 1);
  assert.equal(view.mode, 'standard');
  assert.equal(view.card, 'Goal rev 2');
  assert.equal(view.revision_history_folded, true);
  assert.equal(view.revision_history.length, 2);
  assert.equal(view.revision_history[0].revision, 1);
  assert.equal(view.revision_history[1].revision, 2);
  assert.ok(!JSON.stringify(view.revision_history).includes('publish v0.3.0'));
});

test('Test 2/9 — resume same goal_id, revision +1, deferred step cleared', () => {
  const created = createGoalRecord({ sessionId: 's', goal: 'release', now: 10 });
  const deferred = applyRevision(created, {
    deferredStepIds: ['npm_publish'],
    revisionReason: 'npm 2FA',
    now: 20,
  }, 'goal_revised');
  const resumed = applyRevision(deferred, {
    resumeStepIds: ['npm_publish'],
    revisionReason: 'continue npm',
    now: 30,
  }, 'goal_resumed');

  assert.equal(resumed.session_id, created.session_id);
  assert.equal(resumed.goal_id, created.goal_id);
  assert.equal(resumed.revision, 3);
  assert.deepEqual(resumed.deferred_step_ids, []);
  assert.equal(resumed.history.filter((event) => event.type === 'goal_resumed').length, 1);
});

test('Test 11 — history is bounded on persist and on the ChatGPT slice', () => {
  let record = createGoalRecord({ sessionId: 's', goal: 'g', now: 1 });
  for (let i = 0; i < HISTORY_PERSIST_MAX + 40; i++) {
    record = appendGoalEvent(record, 'step_completed', { step_id: `s${i}`, now: i + 2 });
  }
  assert.equal(record.history.length, HISTORY_PERSIST_MAX);
  assert.ok(record.history_seq > HISTORY_PERSIST_MAX);

  const io = memoryStoreIo();
  const store = new GoalControlStore(io);
  store.put(record);
  const reloaded = parseGoalRecord(io.files.get('s'));
  assert.equal(reloaded.history.length, HISTORY_PERSIST_MAX);

  const wire = sliceHistory(reloaded.history);
  assert.equal(wire.length, HISTORY_WIRE_MAX);
  const since = wire[0].seq - 1;
  const page = sliceHistory(reloaded.history, since);
  assert.equal(page[0].seq, wire[0].seq);
});

test('Test 12 — history metadata never stores token / password / OTP / Authorization / cookie', () => {
  const created = createGoalRecord({ sessionId: 's', goal: 'g', now: 1 });
  const recorded = appendGoalEvent(created, 'question_answered', {
    now: 2,
    metadata: {
      token: 'super-secret-token-value',
      password: 'hunter2-password',
      otp: '123456',
      authorization: 'Bearer abcdefghijklmnop',
      cookie: 'sid=abc123xyz',
      note: 'user answered',
    },
  });
  const event = recorded.history.find((item) => item.type === 'question_answered');
  const dumped = JSON.stringify(event);
  assert.equal(event.metadata.token, '[REDACTED]');
  assert.equal(event.metadata.password, '[REDACTED]');
  assert.equal(event.metadata.otp, '[REDACTED]');
  assert.equal(event.metadata.authorization, '[REDACTED]');
  assert.equal(event.metadata.cookie, '[REDACTED]');
  assert.equal(event.metadata.note, 'user answered');
  assert.doesNotMatch(dumped, /super-secret-token-value/);
  assert.doesNotMatch(dumped, /hunter2/);
  assert.doesNotMatch(dumped, /123456/);
  assert.doesNotMatch(dumped, /Bearer abcdefghijklmnop/);
  assert.doesNotMatch(dumped, /sid=abc123xyz/);
});

test('sidecar reload restores revision history', () => {
  const io = memoryStoreIo();
  const store = new GoalControlStore(io);
  const first = createGoalRecord({ sessionId: 'sess-a', goal: 'one', now: 1 });
  store.put(first);
  store.put(applyRevision(first, { goal: 'two', now: 2 }, 'goal_revised'));

  const cold = new GoalControlStore(io);
  const loaded = cold.get('sess-a');
  assert.equal(loaded.revision, 2);
  assert.equal(loaded.revisions[0].goal, 'one');
  assert.equal(loaded.revisions[1].goal, 'two');
});

test('Test B — native get_goal null does not override supervised Goal', () => {
  const created = createGoalRecord({
    sessionId: 'session-123',
    goal: '只等待 35 秒',
    mode: 'minimal',
    now: 1,
  });
  const revised = applyRevision(created, {
    goal: '只等待 35 秒',
    mode: 'minimal',
    revisionReason: 'user_modified_goal',
    now: 2,
  }, 'goal_revised');
  assert.equal(revised.goal_id, 'goal-session-123');
  assert.equal(revised.revision, 2);
  assert.equal(revised.mode, 'minimal');

  const store = new GoalControlStore(memoryStoreIo());
  store.put(revised);
  const before = store.get('session-123');
  const historyBefore = structuredClone(before.history);
  const revisionsBefore = structuredClone(before.revisions);
  const constraintsBefore = { ...before.constraints };

  const after = applyNativeGetGoalResult(before, { goal: null });
  assert.equal(after, before);
  assert.equal(after.goal_id, 'goal-session-123');
  assert.equal(after.revision, 2);
  assert.equal(after.mode, 'minimal');
  assert.deepEqual(after.history, historyBefore);
  assert.deepEqual(after.revisions, revisionsBefore);
  assert.deepEqual(after.constraints, constraintsBefore);

  const still = store.get('session-123');
  assert.equal(still.goal_id, 'goal-session-123');
  assert.equal(still.revision, 2);
  assert.equal(still.mode, 'minimal');
  assert.deepEqual(still.history, historyBefore);
  assert.equal(applyNativeGetGoalResult(undefined, { goal: null }), undefined);
});

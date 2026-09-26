import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResultSchema, extractArtifacts, extractCommitShas, extractTagNames } from '../../lib/result-schema.js';
import { applyRevision, createGoalRecord } from '../../lib/goal-control.js';

test('A14 / R12: buildResultSchema generates structured results with test metrics and changes', () => {
  const record = createGoalRecord({
    sessionId: 'session-res',
    goal: 'Run tests and verify build',
  });

  const events = [
    {
      type: 'tool/call',
      seq: 1,
      data: {
        turn: 1,
        callId: 'c1',
        name: 'bash',
        arguments: JSON.stringify({ command: 'node --test test/unit/sample.test.mjs' }),
      },
    },
    {
      type: 'tool/result',
      seq: 2,
      data: {
        turn: 1,
        message: {
          source: { callId: 'c1' },
          content: [{ type: 'tool', isError: false, content: '✔ pass 203\nℹ tests 203\nℹ pass 203\nℹ fail 0' }],
        },
      },
    },
    {
      type: 'tool/call',
      seq: 3,
      data: {
        turn: 1,
        callId: 'c2',
        name: 'write',
        arguments: JSON.stringify({ path: 'src/sample.ts' }),
      },
    },
    {
      type: 'tool/result',
      seq: 4,
      data: {
        turn: 1,
        message: { source: { callId: 'c2' }, content: [{ type: 'tool', isError: false, content: 'ok' }] },
      },
    },
  ];

  const result = buildResultSchema({
    sessionId: 'session-res',
    record,
    events,
    status: 'completed',
    workspace: 'D:/test-workspace',
    evidenceIds: ['evidence-12345'],
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.goal.goal_id, 'goal-session-res');
  assert.equal(result.goal.revision, 1);
  assert.equal(result.goal.card, 'Goal rev 1');
  assert.equal(result.goal.revision_history_folded, false);
  assert.equal(result.tests.pass, 203);
  assert.equal(result.tests.total, 203);
  assert.ok(result.tests.evidence_ids.includes('evidence-12345'));
  assert.ok(result.changes.changed_files.includes('src/sample.ts'));
  assert.equal(result.security.secret_leak_check, true);
  assert.equal(result.provenance.session_id, 'session-res');
});

test('A14: commit SHAs, tags, and tarball artifacts are parsed from tool evidence', () => {
  const record = createGoalRecord({
    sessionId: 'session-rel',
    goal: 'Commit, tag, and pack',
  });
  const events = [
    {
      type: 'tool/call',
      seq: 1,
      data: {
        turn: 1,
        callId: 'c-commit',
        name: 'bash',
        arguments: JSON.stringify({ command: 'git commit -m "fix tests"' }),
      },
    },
    {
      type: 'tool/result',
      seq: 2,
      data: {
        turn: 1,
        message: {
          source: { callId: 'c-commit' },
          content: [{ type: 'tool', isError: false, content: '[main a1b2c3d4e5f6] fix tests\n 2 files changed' }],
        },
      },
    },
    {
      type: 'tool/call',
      seq: 3,
      data: {
        turn: 1,
        callId: 'c-tag',
        name: 'bash',
        arguments: JSON.stringify({ command: 'git tag v0.1.0' }),
      },
    },
    {
      type: 'tool/result',
      seq: 4,
      data: {
        turn: 1,
        message: { source: { callId: 'c-tag' }, content: [{ type: 'tool', isError: false, content: 'Created tag v0.1.0' }] },
      },
    },
    {
      type: 'tool/call',
      seq: 5,
      data: {
        turn: 1,
        callId: 'c-pack',
        name: 'bash',
        arguments: JSON.stringify({ command: 'npm pack' }),
      },
    },
    {
      type: 'tool/result',
      seq: 6,
      data: {
        turn: 1,
        message: {
          source: { callId: 'c-pack' },
          content: [{
            type: 'tool',
            isError: false,
            content: 'npm notice filename: probemux-0.1.0.tgz\nnpm notice package size: 12.5 kB\nsha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          }],
        },
      },
    },
  ];

  const result = buildResultSchema({
    sessionId: 'session-rel',
    record,
    events,
    status: 'completed',
    workspace: 'D:/workspace/probemux',
  });

  assert.ok(result.changes.commits.includes('a1b2c3d4e5f6'));
  assert.ok(!result.changes.commits.includes('local-commit'));
  assert.ok(result.changes.tags.includes('v0.1.0'));
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].name, 'probemux-0.1.0.tgz');
  assert.equal(result.artifacts[0].hash, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
  assert.ok((result.artifacts[0].size ?? 0) > 1000);
});

test('A14: secret-shaped tool output fails secret_leak_check without echoing the secret', () => {
  const result = buildResultSchema({
    sessionId: 'session-sec',
    events: [
      {
        type: 'tool/call',
        seq: 1,
        data: { turn: 1, callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'echo leak' }) },
      },
      {
        type: 'tool/result',
        seq: 2,
        data: {
          turn: 1,
          message: {
            source: { callId: 'c1' },
            content: [{ type: 'tool', isError: false, content: 'api_key=sk-leaked-secret-value-should-not-appear' }],
          },
        },
      },
    ],
    status: 'completed',
    workspace: 'D:/ws',
  });
  assert.equal(result.security.secret_leak_check, false);
  assert.ok(result.warnings.length > 0);
  const json = JSON.stringify(result);
  assert.doesNotMatch(json, /sk-leaked-secret-value-should-not-appear/);
});

test('R12 / A16: rev1→rev4 is one Goal card with folded history, not four cards', () => {
  let record = createGoalRecord({ sessionId: 'session-fold', goal: 'rev one', now: 1 });
  record = applyRevision(record, { goal: 'rev two', revisionReason: 'user_modified_goal', now: 2 }, 'goal_revised');
  record = applyRevision(record, { goal: 'rev three', revisionReason: 'user_modified_goal', now: 3 }, 'goal_revised');
  record = applyRevision(record, { goal: 'rev four', revisionReason: 'user_modified_goal', now: 4 }, 'goal_revised');
  assert.equal(record.revision, 4);

  const result = buildResultSchema({
    sessionId: 'session-fold',
    record,
    events: [],
    status: 'completed',
    workspace: 'D:/ws',
  });
  assert.equal(result.goal.card, 'Goal rev 4');
  assert.equal(result.goal.revision_history_folded, true);
  assert.equal(result.goal.revision_history.length, 4);
  assert.deepEqual(result.goal.revision_history.map((item) => item.revision), [1, 2, 3, 4]);
  assert.equal(result.goal.revision_history.filter((item) => item.revision === 4).length, 1);
});

test('extract helpers parse git and pack evidence', () => {
  assert.deepEqual(extractCommitShas('[main abcdef1] fix\n 1 file changed'), ['abcdef1']);
  assert.ok(extractTagNames('git tag v1.2.3', '').includes('v1.2.3'));
  const artifacts = extractArtifacts([
    {
      seq: 1,
      callId: 'c',
      name: 'bash',
      kinds: ['npm_pack'],
      ok: true,
      command: 'npm pack',
      resultText: 'npm notice filename: pkg-1.0.0.tgz',
    },
  ]);
  assert.equal(artifacts[0]?.name, 'pkg-1.0.0.tgz');
});

test('live structured results preserve running status and omit terminal timestamp', () => {
  const result = buildResultSchema({
    sessionId: 'session-running',
    events: [],
    status: 'running',
    workspace: 'D:/ws',
  });
  assert.equal(result.status, 'running');
  assert.equal('finished_at' in result.goal, false);
});

test('terminal structured results preserve the exact status and include terminal timestamp', () => {
  const result = buildResultSchema({
    sessionId: 'session-interrupted',
    events: [],
    status: 'interrupted',
    workspace: 'D:/ws',
  });
  assert.equal(result.status, 'interrupted');
  assert.equal(typeof result.goal.finished_at, 'string');
});

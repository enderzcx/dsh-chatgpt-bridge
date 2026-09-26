/**
 * The read-only status path must not mutate anything.
 *
 * `dsh_get_task_status` / `dsh_get_session` reach `goalFields` → `observeGoal`,
 * which can write the Goal store, remember observed executions, refresh a
 * workspace baseline, record idempotency evidence, advance the poll cursor,
 * release the workspace lock and delete temp resources. Every one of those is
 * replaced here with a stub that throws, so a passing test means none ran.
 *
 * The same harness is then driven through the identical seam WITHOUT read-only
 * and must trip the stubs, which is what proves the clean result is an absence
 * of writes rather than a harness that never had a chance to write.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bridge } from '../../lib/bridge.js';

// Machine-independent paths: everything is derived from HOME so this
// harness runs on any checkout, not just the author's machine.
const HOME = process.env.HOME ?? '';
const WORKSPACE = process.env.DSH_BRIDGE_WORKSPACE ?? `${HOME}/Work/CODEX`;
const CODEX_HOME_DIR = process.env.DSH_BRIDGE_CODEX_HOME ?? `${HOME}/.dsh/chatgpt-bridge/codex-home`;
const LIVE_POLICY = process.env.DSH_BRIDGE_POLICY ?? `${HOME}/.dsh/chatgpt-bridge/direct-ops/policy.json`;
const OUTSIDE_PROBE = `${HOME}/codex-backend-outside-probe.txt`;
const PLUGIN_LIB = process.env.DSH_BRIDGE_PLUGIN_LIB ?? `${HOME}/.dsh/profiles/desktop/node_modules/dsh-chatgpt-bridge/lib`;

const WS = WORKSPACE;

/** A live-agent bridge whose log contains a SUCCESSFUL mutating tool call. */
function makeHarness() {
  const events = [];
  const now = Date.now();
  const push = (type, data) => events.push({ type, seq: events.length, time: now + events.length, data });
  push('turn/start', { turn: 1 });
  push('todo/write', { todos: [{ content: 'C1 push release commit', status: 'pending' }] });
  push('tool/call', { turn: 1, step: 0, callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'git push origin main' }) });
  push('tool/result', { callId: 'c1', ok: true, content: [{ type: 'text', text: 'pushed' }] });
  push('turn/start', { turn: 2 });
  push('turn/end', { turn: 2, reason: { kind: 'completed' } });

  const agent = {
    id: 'session-ro',
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [], hasPending: false },
    session: {
      id: 'session-ro',
      header: { id: 'session-ro', createdAt: now, cwd: WS },
      events,
      snapshotEvents: () => events,
      requestHeader: () => undefined,
    },
  };
  const services = {
    workspaceRegistry: { list: () => [], attachSession: async () => {} },
    agents: { get: (id) => (id === agent.id ? agent : undefined), list: () => [agent] },
    sessions: { list: () => [], get: () => undefined },
    sessionPersistence: { list: async () => [] },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  };
  const ctx = {
    get: (key) => services[key],
    agents: services.agents,
    sessions: services.sessions,
    sessionPersistence: services.sessionPersistence,
    agentDefaultModel: services.agentDefaultModel,
    sessionTitle: undefined,
    on: () => {},
  };
  const bridge = new Bridge(ctx, { sessionMaxItems: 5, sessionMaxChars: 400, resultMaxItems: 10, resultMaxChars: 500 }, {
    debug() {}, info() {}, warn() {}, error() {},
  });
  const record = {
    goal_id: 'goal-ro', session_id: agent.id, workspace: WS, goal: 'ship', plan: 'push',
    mode: 'standard', revision: 1, revisions: [], constraints: {}, completed_action_kinds: [],
    deferred_step_ids: [], blockers: [], history: [], created_at: 'x', updated_at: 'x',
  };
  bridge['goalStore'].put(record);
  return { bridge, agent, loaded: { agent, session: agent.session, events, header: agent.session.header } };
}

/** Arm every mutation the status path could reach; record and throw. */
function armMutations(bridge) {
  const touched = [];
  const arm = (label, target, method) => {
    if (target?.[method] === undefined) return;
    target[method] = () => {
      touched.push(label);
      throw new Error(`SIDE EFFECT: ${label}`);
    };
  };
  arm('goalStore.put', bridge['goalStore'], 'put');
  arm('pollCursors.set', bridge['pollCursors'], 'set');
  arm('workspaceGuard.releaseLock', bridge['workspaceGuard'], 'releaseLock');
  arm('workspaceGuard.recordMutation', bridge['workspaceGuard'], 'recordMutation');
  arm('workspaceGuard.beginBaselineRefresh', bridge['workspaceGuard'], 'beginBaselineRefresh');
  arm('workspaceBaselines.set', bridge['workspaceBaselines'], 'set');
  arm('cleanupGoalTemps', bridge, 'cleanupGoalTemps');
  arm('recordObservedExecutions', bridge, 'recordObservedExecutions');
  return touched;
}

test('getTaskStatus is side-effect free with every mutation armed', async () => {
  const { bridge, agent } = makeHarness();
  const touched = armMutations(bridge);

  const status = await bridge.getTaskStatus(agent.id);

  assert.equal(status.status, 'completed');
  assert.ok(status.goal, 'the Goal view must still be produced from a read-only path');
  assert.deepEqual(touched, [], 'a status read must not touch any mutation');
  // The lock is deliberately NOT released by a read, even on a terminal goal.
  assert.equal(bridge['goalStore'].get(agent.id).revision, 1);
});

test('getSession is side-effect free with every mutation armed', async () => {
  const { bridge, agent } = makeHarness();
  const touched = armMutations(bridge);

  const session = await bridge.getSession(agent.id);

  assert.ok(Array.isArray(session.todos), 'todos must still be reported');
  assert.ok(session.goal, 'the Goal view must still be reported');
  assert.deepEqual(touched, [], 'a session read must not touch any mutation');
});

test('the read-only flag is what prevents the write, not an unused code path', async () => {
  const { bridge, agent, loaded } = makeHarness();

  // Without read-only, the same seam writes: it records the observed successful
  // mutation and updates the Goal store.
  const withoutFlag = armMutations(bridge);
  assert.throws(() => bridge['observeGoal'](agent.id, loaded, 'completed'), /SIDE EFFECT/);
  assert.ok(withoutFlag.length > 0, 'the non-read-only path must reach a mutation');
  await agent;

  // With read-only, the identical input writes nothing.
  const fresh = makeHarness();
  const withFlag = armMutations(fresh.bridge);
  fresh.bridge['observeGoal'](fresh.agent.id, fresh.loaded, 'completed', { readOnly: true });
  assert.deepEqual(withFlag, [], 'read-only must skip every mutation');
});

test('wait is NOT read-only: it reaches the cursor write', async () => {
  const { bridge, agent, loaded } = makeHarness();
  // Arm ONLY the poll cursor, so the wait path can complete far enough to reach
  // it. (A fully armed harness stops earlier, at the execution recorder, which
  // is itself a write — see the next test.)
  const writes = [];
  bridge['pollCursors'].set = (...args) => {
    writes.push(args.length);
    throw new Error('SIDE EFFECT: pollCursors.set');
  };

  await assert.rejects(() => bridge['goalSnapshot'](agent.id, loaded, 'completed', 10, 1), /pollCursors\.set/);
  assert.ok(writes.length > 0, 'the non-read-only snapshot must advance the cursor');

  // The read-only snapshot must not, on the identical input.
  const fresh = makeHarness();
  const readOnlyWrites = [];
  fresh.bridge['pollCursors'].set = () => { readOnlyWrites.push(1); throw new Error('SIDE EFFECT: pollCursors.set'); };
  const snapshot = await fresh.bridge['goalSnapshot'](fresh.agent.id, fresh.loaded, 'completed', 10, 1, { readOnly: true });
  assert.deepEqual(readOnlyWrites, [], 'a read-only snapshot must not advance the cursor');
  assert.ok(snapshot.session_id === fresh.agent.id, 'the read-only snapshot still returns a result');
});

test('wait also records observed executions, so it is annotated as a writer', async () => {
  const { bridge, agent, loaded } = makeHarness();
  const writes = [];
  bridge['recordObservedExecutions'] = () => { writes.push(1); throw new Error('SIDE EFFECT: recordObservedExecutions'); };

  await assert.rejects(() => bridge['goalSnapshot'](agent.id, loaded, 'completed', 10, 1), /recordObservedExecutions/);
  assert.ok(writes.length > 0, 'the non-read-only snapshot records execution evidence');

  const fresh = makeHarness();
  const readOnlyWrites = [];
  fresh.bridge['recordObservedExecutions'] = () => { readOnlyWrites.push(1); throw new Error('SIDE EFFECT'); };
  await fresh.bridge['goalSnapshot'](fresh.agent.id, fresh.loaded, 'completed', 10, 1, { readOnly: true });
  assert.deepEqual(readOnlyWrites, [], 'read-only must skip execution recording');
});

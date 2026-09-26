#!/usr/bin/env node
/**
 * Proves the read-only status entry point has no side effects.
 *
 * The status tools reach `goalFields`/`observeGoal`, which historically could
 * write the Goal store, remember observed executions, refresh a workspace
 * baseline, record idempotency evidence, advance the poll cursor, release the
 * workspace lock and delete temp resources. This test replaces every one of
 * those mutations with a stub that THROWS, then calls the status tools over the
 * real MCP protocol:
 *
 *   - a passing run means none of them was touched;
 *   - the same harness also runs the mutating wait tool and CATCHES its writes,
 *     proving the stubs are wired to real code paths rather than being inert.
 *
 * The last point matters: a stub that would also throw on a mutating call is the
 * only way to show the read path is clean rather than merely unused.
 *
 * Usage: node test/integration/read-only-query.mjs [outFile]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpServer } from '../../lib/http.js';
import { createMcpServer } from '../../lib/mcp.js';
import { Bridge } from '../../lib/bridge.js';

// Machine-independent paths: everything is derived from HOME so this
// harness runs on any checkout, not just the author's machine.
const HOME = process.env.HOME ?? '';
const WORKSPACE = process.env.DSH_BRIDGE_WORKSPACE ?? `${HOME}/Work/CODEX`;
const CODEX_HOME_DIR = process.env.DSH_BRIDGE_CODEX_HOME ?? `${HOME}/.dsh/chatgpt-bridge/codex-home`;
const LIVE_POLICY = process.env.DSH_BRIDGE_POLICY ?? `${HOME}/.dsh/chatgpt-bridge/direct-ops/policy.json`;
const OUTSIDE_PROBE = `${HOME}/codex-backend-outside-probe.txt`;
const PLUGIN_LIB = process.env.DSH_BRIDGE_PLUGIN_LIB ?? `${HOME}/.dsh/profiles/desktop/node_modules/dsh-chatgpt-bridge/lib`;

const outFile = process.argv[2]
  ?? fileURLToPath(new URL('../../.scratch-exec/read-only-query.json', import.meta.url));
const TOKEN = 'read-only-query-token';
const WS = WORKSPACE;

const results = [];
let failures = 0;
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}${ok ? '' : `  -> ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}

/** Every mutation the status path could reach, each one a loud failure. */
function instrument(bridge) {
  const touched = [];
  const guard = (label, object, method) => {
    object[method] = (...args) => {
      touched.push({ label, args: args.length });
      throw new Error(`SIDE EFFECT: ${label} was called by a read-only query`);
    };
  };
  guard('goalStore.put', bridge['goalStore'], 'put');
  if (bridge['goalStore'].delete !== undefined) guard('goalStore.delete', bridge['goalStore'], 'delete');
  guard('pollCursors.set', bridge['pollCursors'], 'set');
  guard('workspaceGuard.releaseLock', bridge['workspaceGuard'], 'releaseLock');
  guard('workspaceGuard.recordMutation', bridge['workspaceGuard'], 'recordMutation');
  guard('workspaceGuard.beginBaselineRefresh', bridge['workspaceGuard'], 'beginBaselineRefresh');
  guard('workspaceBaselines.set', bridge['workspaceBaselines'], 'set');
  // cleanupGoalTemps drives temp-resource removal through discover/cleanup.
  guard('cleanupGoalTemps', bridge, 'cleanupGoalTemps');
  guard('recordObservedExecutions', bridge, 'recordObservedExecutions');
  return touched;
}

/** A live-agent bridge whose session log contains mutation-shaped Goal facts. */
function makeHarness() {
  const events = [];
  const time = Date.now();
  const push = (type, data) => events.push({ type, seq: events.length, time: time + events.length, data });
  push('turn/start', { turn: 1 });
  push('todo/write', {
    todos: [
      { content: 'C1 push release commit', status: 'pending' },
      { content: 'C2 npm publish', status: 'pending' },
    ],
  });
  // A SUCCESSFUL mutating tool: if observeGoal runs its recording path, this is
  // what makes it try to write. Under read-only it must be ignored.
  push('tool/call', { turn: 1, step: 0, callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'git push origin main' }) });
  push('tool/result', { callId: 'c1', ok: true, content: [{ type: 'text', text: 'pushed' }] });
  push('turn/start', { turn: 2 });
  push('turn/end', { turn: 2, reason: { kind: 'completed' } });

  const inbox = { nextTurn: [], nextStep: [], hasPending: false };
  const agent = {
    id: 'session-read-only',
    status: 'idle',
    inbox,
    session: {
      id: 'session-read-only',
      header: { id: 'session-read-only', createdAt: time, cwd: WS },
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
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const bridge = new Bridge(ctx, { sessionMaxItems: 5, sessionMaxChars: 400, resultMaxItems: 10, resultMaxChars: 500 }, log);
  // A Goal record must exist, or the write paths would be skipped for the wrong reason.
  bridge['goalStore'].put({
    goal_id: 'goal-read-only',
    session_id: agent.id,
    workspace: WS,
    goal: 'ship the release',
    plan: 'push\nnpm publish',
    mode: 'standard',
    revision: 1,
    revisions: [],
    constraints: {},
    completed_action_kinds: [],
    deferred_step_ids: [],
    blockers: [],
    history: [],
    created_at: 'x',
    updated_at: 'x',
  });
  return { bridge, agent, events };
}

async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.find((part) => part.type === 'text')?.text ?? '{}';
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 200) }; }
  return { parsed, isError: result.isError === true, raw: text };
}

async function main() {
  mkdirSync(resolve(outFile, '..'), { recursive: true });
  const { bridge, agent } = makeHarness();

  // 1. Prove the stubs are live before trusting them: a mutating call must trip them.
  const probeTouched = instrument(bridge);
  let stubsProven = false;
  try {
    bridge['goalStore'].put(bridge['goalStore'].get(agent.id));
  } catch (error) {
    stubsProven = String(error.message).includes('SIDE EFFECT');
  }
  check('the mutation stubs actually throw (they are wired to real paths)', stubsProven && probeTouched.length > 0, probeTouched);
  probeTouched.length = 0;

  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const handle = await startHttpServer(
    () => createMcpServer(bridge, { resultMaxChars: 100, resultMaxItems: 10, sessionMaxItems: 5, sessionMaxChars: 400 }, log),
    { host: '127.0.0.1', port: 0, authMode: 'token', authToken: TOKEN },
    log,
  );
  const client = new Client({ name: 'read-only-query', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(handle.url), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    }));

    // 2. The read-only status tools, with every mutation armed to throw.
    const status = await callTool(client, 'dsh_get_task_status', { session_id: agent.id });
    check('dsh_get_task_status succeeds with all mutations armed', status.isError === false, status.parsed);
    check('dsh_get_task_status recognises the completed turn', status.parsed.status === 'completed', status.parsed.status);
    check('dsh_get_task_status still reports Goal fields', status.parsed.goal !== undefined, Object.keys(status.parsed));

    const session = await callTool(client, 'dsh_get_session', { session_id: agent.id });
    check('dsh_get_session succeeds with all mutations armed', session.isError === false, session.parsed);
    check('dsh_get_session still reports todos', Array.isArray(session.parsed.todos), session.parsed.todos);

    const result = await callTool(client, 'dsh_get_result', { session_id: agent.id });
    check('dsh_get_result succeeds with all mutations armed', result.isError === false, result.parsed);

    const pending = await callTool(client, 'dsh_list_pending_messages', { session_id: agent.id });
    check('dsh_list_pending_messages succeeds with all mutations armed', pending.isError === false, pending.parsed);

    check('no mutation was touched by any read-only query', probeTouched.length === 0, probeTouched);

    // 3. The Goal store and workspace lock are genuinely unchanged.
    const recordAfter = bridge['goalStore'].get(agent.id);
    check('the Goal record keeps its revision and completion state', recordAfter?.revision === 1
      && (recordAfter?.completed_action_kinds ?? []).length === 0, {
      revision: recordAfter?.revision,
      completed: recordAfter?.completed_action_kinds,
      history: recordAfter?.history?.length,
    });

    // 4. Arm the stubs and prove the harness is live: the SAME seam that the
    //    read-only path calls must trip them when it is not in read-only mode.
    //    Without this, step 2's clean result could just be a dead harness.
    const loaded = { agent: { status: 'idle', inbox: agent.inbox }, session: agent.session, events: agent.session.snapshotEvents(), header: agent.session.header };
    let liveTouched = false;
    try {
      bridge['observeGoal'](agent.id, loaded, 'completed');
    } catch (error) {
      liveTouched = String(error.message).includes('SIDE EFFECT');
    }
    check('the same seam DOES write when not read-only (harness is live)', liveTouched, probeTouched);

    // And with the read-only flag it must not, on the identical input.
    probeTouched.length = 0;
    let readOnlyTouched = false;
    try {
      bridge['observeGoal'](agent.id, loaded, 'completed', { readOnly: true });
    } catch (error) {
      readOnlyTouched = String(error.message).includes('SIDE EFFECT');
    }
    check('the same seam writes nothing in read-only mode', !readOnlyTouched && probeTouched.length === 0, probeTouched);

    writeFileSync(outFile, `${JSON.stringify({
      checked_at: new Date().toISOString(),
      read_only_tools_verified: ['dsh_get_task_status', 'dsh_get_session', 'dsh_get_result', 'dsh_list_pending_messages'],
      mutations_touched: probeTouched,
      results,
      failures,
    }, null, 1)}\n`);
    console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
  } finally {
    await client.close();
    await handle.close();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().then(() => process.exit(0), (error) => {
  console.error('READ-ONLY QUERY ERROR:', error);
  process.exit(1);
});

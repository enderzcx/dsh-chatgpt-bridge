#!/usr/bin/env node
/**
 * Annotation disclosure check over the real MCP protocol.
 *
 * Every advertised tool must declare readOnlyHint, destructiveHint and
 * openWorldHint, and those values must match what the tool actually does —
 * including INDIRECT side effects. This asserts the specific cases that are easy
 * to get wrong:
 *
 *   - dsh_get_session / dsh_get_task_status are advertised read-only AND are
 *     proven side-effect free by `read-only-query.mjs`;
 *   - dsh_wait_goal / dsh_wait_until_action_required are NOT read-only, because
 *     they advance a progress cursor, write the Goal store, release the
 *     workspace lock and clean up temp resources on a terminal goal;
 *   - command execution is not read-only and is open-world;
 *   - operator policy reload is a write, not a read.
 *
 * Annotations describe behaviour to the host. They are not a claim that any
 * platform will allow the call.
 *
 * Usage: node test/integration/annotation-check.mjs [outFile]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpServer } from '../../lib/http.js';
import { createMcpServer } from '../../lib/mcp.js';
import { createDirectOpsRuntime } from '../../lib/direct/tools.js';

// Machine-independent paths: everything is derived from HOME so this
// harness runs on any checkout, not just the author's machine.
const HOME = process.env.HOME ?? '';
const WORKSPACE = process.env.DSH_BRIDGE_WORKSPACE ?? `${HOME}/Work/CODEX`;
const CODEX_HOME_DIR = process.env.DSH_BRIDGE_CODEX_HOME ?? `${HOME}/.dsh/chatgpt-bridge/codex-home`;
const LIVE_POLICY = process.env.DSH_BRIDGE_POLICY ?? `${HOME}/.dsh/chatgpt-bridge/direct-ops/policy.json`;
const OUTSIDE_PROBE = `${HOME}/codex-backend-outside-probe.txt`;
const PLUGIN_LIB = process.env.DSH_BRIDGE_PLUGIN_LIB ?? `${HOME}/.dsh/profiles/desktop/node_modules/dsh-chatgpt-bridge/lib`;

const outFile = process.argv[2]
  ?? fileURLToPath(new URL('../../.scratch-exec/annotation-check.json', import.meta.url));
const TOKEN = 'annotation-check-token';
const WS = WORKSPACE;
const CODEX_BIN = process.env.CODEX_BIN
  ?? '/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex';

const results = [];
let failures = 0;
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}${ok ? '' : `  -> ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}

async function main() {
  mkdirSync(resolve(outFile, '..'), { recursive: true });
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const runtime = createDirectOpsRuntime({
    enabled: true,
    roots: [WS],
    allowWrites: true,
    writableRoots: [WS],
    exec: {
      enabled: true,
      allowedCommands: ['pwd'],
      cwdRoots: [WS],
      writableRoots: [WS],
      network: 'deny',
      filesystem: 'roots',
      backend: 'codex-app-server',
      codexBin: CODEX_BIN,
      codexHome: fileURLToPath(new URL('../../.scratch-exec/codex-home', import.meta.url)),
    },
  });
  const handle = await startHttpServer(
    () => createMcpServer({}, { resultMaxChars: 100, resultMaxItems: 10, sessionMaxItems: 5, sessionMaxChars: 100 }, log, runtime),
    { host: '127.0.0.1', port: 0, authMode: 'token', authToken: TOKEN },
    log,
  );
  const client = new Client({ name: 'annotation-check', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(handle.url), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    }));
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    // 1. every tool declares all three hints as booleans
    const missing = tools.filter((tool) => tool.annotations === undefined
      || typeof tool.annotations.readOnlyHint !== 'boolean'
      || typeof tool.annotations.destructiveHint !== 'boolean'
      || typeof tool.annotations.openWorldHint !== 'boolean');
    check('every advertised tool declares readOnly/destructive/openWorld', missing.length === 0, missing.map((t) => t.name));
    check('the bridge and direct surfaces are both advertised', tools.length === 36, tools.length);

    // 2. pure reads: the only tools allowed to claim read-only
    const pureReads = [
      'dsh_health', 'dsh_list_workspaces', 'dsh_list_sessions', 'dsh_get_session',
      'dsh_get_result', 'dsh_get_task_status', 'dsh_credential_status',
      'dsh_list_pending_messages', 'dsh_read_text_file', 'dsh_read_command_output',
      'dsh_operator_roots',
    ];
    const actualReadOnly = tools.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name).sort();
    check(
      'read-only is claimed by exactly the pure-inspection tools',
      actualReadOnly.join(',') === [...pureReads].sort().join(','),
      { actual: actualReadOnly, expected: [...pureReads].sort() },
    );
    for (const name of pureReads) {
      const tool = byName.get(name);
      check(`${name}: read-only, not destructive`, tool.annotations.destructiveHint === false, tool.annotations);
    }

    // 3. tools that drive or release agent execution. These are the ones that
    //    were previously under-classified as merely "appending to a queue": the
    //    reachable effect is a whole agent turn, so they are destructive and
    //    open-world by reachable behaviour, not by what the bridge's own code does.
    const drivesAgent = [
      'dsh_create_session', 'dsh_send_message', 'dsh_answer_question', 'dsh_approve',
      'dsh_create_goal', 'dsh_start_goal', 'dsh_revise_goal', 'dsh_update_goal',
      'dsh_resume_goal', 'dsh_retry_step', 'dsh_rerun_step',
    ];
    for (const name of drivesAgent) {
      const a = byName.get(name).annotations;
      check(
        `${name}: drives agent execution -> destructive + open-world`,
        a.readOnlyHint === false && a.destructiveHint === true && a.openWorldHint === true,
        a,
      );
    }
    check(
      'answering a question and approving a parked call are classified like execution',
      byName.get('dsh_answer_question').annotations.destructiveHint === true
        && byName.get('dsh_approve').annotations.destructiveHint === true,
      { answer: byName.get('dsh_answer_question').annotations, approve: byName.get('dsh_approve').annotations },
    );

    // 4. waits observe a live agent and write local bookkeeping: not read-only,
    //    destructive and open-world because the observed agent can act.
    for (const name of ['dsh_wait_goal', 'dsh_wait_until_action_required']) {
      const a = byName.get(name).annotations;
      check(
        `${name}: observes a live agent and writes local state -> destructive + open-world`,
        a.readOnlyHint === false && a.destructiveHint === true && a.openWorldHint === true
          && a.idempotentHint === false,
        a,
      );
    }

    // 5. local-state writes that destroy something, but cannot reach outside this host
    const localDestructive = [
      'dsh_cancel_task', 'dsh_stop_goal', 'dsh_edit_pending_message',
      'dsh_withdraw_pending_message', 'dsh_write_text_file', 'dsh_edit_text_file',
      'dsh_operator_reload_policy', 'dsh_terminate_command',
    ];
    for (const name of localDestructive) {
      const a = byName.get(name).annotations;
      check(`${name}: destructive`, a.destructiveHint === true && a.readOnlyHint === false, a);
    }
    // Overwriting or removing a queued message is data loss, not an addition.
    for (const name of ['dsh_edit_pending_message', 'dsh_withdraw_pending_message']) {
      check(
        `${name}: replacing/removing a queued message is destructive`,
        byName.get(name).annotations.destructiveHint === true,
        byName.get(name).annotations,
      );
    }
    // Reordering a queue loses nothing.
    check(
      'promoting a queued message only reorders: not destructive',
      byName.get('dsh_promote_pending_message').annotations.destructiveHint === false,
      byName.get('dsh_promote_pending_message').annotations,
    );
    check(
      'pausing a goal stops nothing permanently: not destructive',
      byName.get('dsh_pause_goal').annotations.destructiveHint === false,
      byName.get('dsh_pause_goal').annotations,
    );

    // 6. open-world is about open/external space, not "called another process".
    //    The command tools reach the network through their child programs.
    for (const name of ['dsh_run_command', 'dsh_start_command', 'dsh_terminate_command']) {
      check(`${name}: open-world (child programs can reach the network)`, byName.get(name).annotations.openWorldHint === true, byName.get(name).annotations);
    }
    //    Direct file tools act on this host only, despite using a local app-server.
    for (const name of ['dsh_read_text_file', 'dsh_write_text_file', 'dsh_edit_text_file', 'dsh_operator_roots', 'dsh_operator_reload_policy']) {
      check(`${name}: not open-world (local filesystem only)`, byName.get(name).annotations.openWorldHint === false, byName.get(name).annotations);
    }
    //    Pure bridge reads act on the local DSH process.
    for (const name of ['dsh_health', 'dsh_get_task_status', 'dsh_get_session', 'dsh_list_sessions', 'dsh_read_command_output']) {
      check(`${name}: not open-world`, byName.get(name).annotations.openWorldHint === false, byName.get(name).annotations);
    }
    check(
      'open-world is claimed only by agent-driving/observing and command tools',
      tools.filter((t) => t.annotations.openWorldHint).map((t) => t.name).sort().join(',')
        === [...drivesAgent, 'dsh_wait_goal', 'dsh_wait_until_action_required',
          'dsh_run_command', 'dsh_start_command', 'dsh_terminate_command'].sort().join(','),
      tools.filter((t) => t.annotations.openWorldHint).map((t) => t.name),
    );

    // 7. idempotency is about repeated side effects, not stable return values.
    for (const name of pureReads) {
      check(
        `${name}: idempotent even though its reported values can change`,
        byName.get(name).annotations.idempotentHint === true,
        byName.get(name).annotations,
      );
    }
    for (const name of ['dsh_wait_goal', 'dsh_wait_until_action_required']) {
      check(
        `${name}: NOT idempotent (a repeat advances local state again)`,
        byName.get(name).annotations.idempotentHint === false,
        byName.get(name).annotations,
      );
    }

    // 7. snapshot for the record
    const table = tools.map((tool) => ({
      name: tool.name,
      readOnlyHint: tool.annotations?.readOnlyHint,
      destructiveHint: tool.annotations?.destructiveHint,
      openWorldHint: tool.annotations?.openWorldHint,
    })).sort((a, b) => a.name.localeCompare(b.name));
    writeFileSync(outFile, `${JSON.stringify({ checked_at: new Date().toISOString(), tools: table, failures }, null, 1)}\n`);

    console.log(`\n${tools.length - missing.length}/${tools.length} tools declare hints; ${results.filter((r) => r.ok).length}/${results.length} checks passed`);
    console.log(`annotation table written to ${outFile}`);
  } finally {
    await client.close();
    await handle.close();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().then(() => process.exit(0), (error) => {
  console.error('ANNOTATION CHECK ERROR:', error);
  process.exit(1);
});

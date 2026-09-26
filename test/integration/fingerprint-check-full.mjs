#!/usr/bin/env node
/**
 * Fingerprint check over the FULL 36-tool surface (agent-control + direct ops).
 *
 * `fingerprint-check.mjs` mounts no direct ops, so it covers the 27 agent tools
 * only. This variant mounts the direct-ops runtime so the advertised surface is
 * the complete 36, and recomputes the fingerprint independently from a real
 * `client.listTools()` payload.
 *
 * Usage: node test/integration/fingerprint-check-full.mjs [outFile]
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpServer } from '../../lib/http.js';
import { createMcpServer } from '../../lib/mcp.js';
import { createDirectOpsRuntime } from '../../lib/direct/tools.js';
import { callDiagnostics } from '../../lib/diagnostics.js';

// Machine-independent paths: everything is derived from HOME so this
// harness runs on any checkout, not just the author's machine.
const HOME = process.env.HOME ?? '';
const WORKSPACE = process.env.DSH_BRIDGE_WORKSPACE ?? `${HOME}/Work/CODEX`;
const CODEX_HOME_DIR = process.env.DSH_BRIDGE_CODEX_HOME ?? `${HOME}/.dsh/chatgpt-bridge/codex-home`;
const LIVE_POLICY = process.env.DSH_BRIDGE_POLICY ?? `${HOME}/.dsh/chatgpt-bridge/direct-ops/policy.json`;
const OUTSIDE_PROBE = `${HOME}/codex-backend-outside-probe.txt`;
const PLUGIN_LIB = process.env.DSH_BRIDGE_PLUGIN_LIB ?? `${HOME}/.dsh/profiles/desktop/node_modules/dsh-chatgpt-bridge/lib`;

const outFile = process.argv[2]
  ?? fileURLToPath(new URL('../../.scratch-exec/fingerprint-full.json', import.meta.url));
const TOKEN = 'fingerprint-full-token';
const WS = WORKSPACE;
const log = { debug() {}, info() {}, warn() {}, error() {} };

/** Canonical JSON with sorted keys, matching the bridge's own hashing. */
const canon = (v) => {
  const walk = (n) => (Array.isArray(n) ? n.map(walk)
    : (n !== null && typeof n === 'object'
      ? Object.fromEntries(Object.keys(n).sort().map((k) => [k, walk(n[k])]))
      : n));
  return JSON.stringify(walk(v));
};

const runtime = createDirectOpsRuntime({
  enabled: true,
  roots: [WS],
  allowWrites: true,
  writableRoots: [WS],
  exec: {
    enabled: true,
    allowedCommands: ['pwd', 'sh', 'node'],
    cwdRoots: [WS],
    writableRoots: [WS],
    network: 'deny',
    filesystem: 'roots',
    backend: 'codex-app-server',
    codexBin: '/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-aarch64/bin/codex',
    pathEntries: ['/opt/homebrew/bin'],
  },
});

const handle = await startHttpServer(
  () => createMcpServer({}, { resultMaxChars: 100, resultMaxItems: 10, sessionMaxItems: 5, sessionMaxChars: 100 }, log, runtime),
  { host: '127.0.0.1', port: 0, authMode: 'token', authToken: TOKEN },
  log,
);
const client = new Client({ name: 'fp-full', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(handle.url), {
  requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
}));
const { tools } = await client.listTools();

// Independent recomputation from the real wire payload.
const material = [...tools].map((t) => canon({
  name: t.name,
  title: t.title ?? null,
  description: t.description ?? '',
  inputSchema: t.inputSchema ?? null,
  annotations: t.annotations ?? null,
  execution: t.execution ?? null,
})).sort();
const expected = createHash('sha256').update(material.join('\n')).digest('hex');
const published = callDiagnostics.snapshot(1).tool_surface;

const direct = tools.filter((t) => !t.name.startsWith('dsh_') || t.name.startsWith('dsh_operator_') || t.name.startsWith('dsh_read_') || t.name.startsWith('dsh_write_') || t.name.startsWith('dsh_edit_text') || t.name.startsWith('dsh_run_') || t.name.startsWith('dsh_start_command') || t.name.startsWith('dsh_terminate_'));
const summary = {
  checked_at: new Date().toISOString(),
  wire_tool_count: tools.length,
  published_count: published?.count,
  published_sha256: published?.sha256,
  recomputed_sha256: expected,
  match: published?.sha256 === expected && published?.count === tools.length,
  names: tools.map((t) => t.name).sort(),
  /** Per-tool name + input-schema + annotations digest, for baseline comparison. */
  surface: tools.map((t) => ({
    name: t.name,
    schema_sha256: createHash('sha256').update(canon(t.inputSchema ?? null)).digest('hex'),
    annotations_sha256: createHash('sha256').update(canon(t.annotations ?? null)).digest('hex'),
    description_sha256: createHash('sha256').update(t.description ?? '').digest('hex'),
  })).sort((a, b) => a.name.localeCompare(b.name)),
};
writeFileSync(outFile, `${JSON.stringify(summary, null, 1)}\n`);
console.log('wire tool count      :', summary.wire_tool_count);
console.log('published count      :', summary.published_count);
console.log('published sha256     :', summary.published_sha256);
console.log('recomputed sha256    :', summary.recomputed_sha256);
console.log('MATCH                :', summary.match);
console.log('direct-ops tools     :', summary.names.filter((n) => !['dsh_health','dsh_list_workspaces','dsh_list_sessions','dsh_create_session','dsh_get_session','dsh_send_message','dsh_get_task_status','dsh_cancel_task','dsh_get_result','dsh_credential_status','dsh_answer_question','dsh_approve','dsh_create_goal','dsh_start_goal','dsh_revise_goal','dsh_update_goal','dsh_resume_goal','dsh_pause_goal','dsh_stop_goal','dsh_retry_step','dsh_rerun_step','dsh_wait_goal','dsh_wait_until_action_required','dsh_list_pending_messages','dsh_promote_pending_message','dsh_edit_pending_message','dsh_withdraw_pending_message','dsh_run_command','dsh_read_text_file','dsh_write_text_file','dsh_edit_text_file','dsh_operator_roots','dsh_operator_reload_policy','dsh_start_command','dsh_read_command_output','dsh_terminate_command'].includes(n)));
void direct;
await client.close();
await handle.close();
process.exit(summary.match ? 0 : 1);

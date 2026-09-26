#!/usr/bin/env node
/**
 * End-to-end proof that the read-only diagnostics surface carries no caller data
 * and that receipts actually correlate.
 *
 * Over the real MCP protocol it: drives a successful call and a failing call,
 * feeds a synthetic secret in as an unknown tool name / method / error code /
 * error message, then asserts that the secret appears NOWHERE in the diagnostics
 * exposed by dsh_operator_roots, and that the successful and failing calls each
 * have matching receive/start/finish receipts.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpServer } from '../../lib/http.js';
import { createMcpServer } from '../../lib/mcp.js';
import { callDiagnostics } from '../../lib/diagnostics.js';

const SECRET = 'sk-live-DIAG-SECRET-abcdef1234567890';
const TOKEN = 'diagnostics-endpoint-token';
const results = [];
let failures = 0;
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}${ok ? '' : `  -> ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
};

const log = { debug() {}, info() {}, warn() {}, error() {} };
const handle = await startHttpServer(
  () => createMcpServer({}, { resultMaxChars: 100, resultMaxItems: 10, sessionMaxItems: 5, sessionMaxChars: 100 }, log),
  { host: '127.0.0.1', port: 0, authMode: 'token', authToken: TOKEN },
  log,
);
const client = new Client({ name: 'diag', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(handle.url), {
  requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
}));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.find((p) => p.type === 'text')?.text ?? '{}';
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 120) }; }
  return { parsed, isError: r.isError === true, correlationId: r.correlation_id };
};

// 1. a successful call carries a correlation id back to the caller
const ok1 = await call('dsh_health', {});
check('a successful tool result carries a correlation_id', typeof ok1.correlationId === 'string' && ok1.correlationId.startsWith('call-'), ok1.correlationId);

// 2. a failing call also carries one
const bad = await call('dsh_get_session', { session_id: 'session-does-not-exist-xyz' });
check('a failing tool result carries a correlation_id', typeof bad.correlationId === 'string', bad.correlationId);
check('the failure is reported as an error result', bad.isError === true, bad.isError);

// 3. feed the secret through every non-allowlisted channel
callDiagnostics.record({ correlationId: 'synthetic-1', phase: 'http_received', method: SECRET, tool: SECRET });
callDiagnostics.record({ correlationId: 'synthetic-2', phase: 'handler_failed', method: 'tools/call', tool: SECRET, errorCode: SECRET });
const codeFromSecretError = callDiagnostics.codeFor(new Error(`failed with ${SECRET}`));
callDiagnostics.record({ correlationId: 'synthetic-3', phase: 'handler_failed', method: 'tools/call', tool: 'dsh_health', errorCode: codeFromSecretError });

// 4. read the diagnostics back through the read-only tool
const health = await call('dsh_health', {});
const serialized = JSON.stringify(health.parsed);
check('the diagnostics surface is reachable read-only via dsh_health', health.isError === false && health.parsed.call_diagnostics !== undefined, Object.keys(health.parsed));
check('the synthetic secret appears nowhere in dsh_health', !serialized.includes(SECRET), serialized.slice(0, 200));
check('no raw error text is stored either', !serialized.includes('failed with'), true);

const diagnostics = health.parsed.call_diagnostics ?? {};
check('coverage states it is in-memory, not persistent', diagnostics.coverage?.persistent === false, diagnostics.coverage);
check('coverage exposes the restart boundary and window', typeof diagnostics.coverage?.process_started_at === 'string' && typeof diagnostics.coverage?.since === 'string', diagnostics.coverage);
check('unknown channels are counted, not stored', (diagnostics.coverage?.unknown_tools ?? 0) >= 2 && (diagnostics.coverage?.unknown_methods ?? 0) >= 1, diagnostics.coverage);

// 5. the tool-surface fingerprint matches what the client really received
const { tools } = await client.listTools();
check('the fingerprint count equals the advertised tool count', diagnostics.tool_surface?.count === tools.length, { fp: diagnostics.tool_surface?.count, wire: tools.length });
check('the fingerprint names its source as tools/list', diagnostics.tool_surface?.source === 'tools/list', diagnostics.tool_surface);
check('the fingerprint is a sha256', /^[0-9a-f]{64}$/.test(String(diagnostics.tool_surface?.sha256)), diagnostics.tool_surface?.sha256);

// 6. THE core requirement: one call's phases share ONE id, and that id is the
//    one the client received. Counting phases is not enough.
// Only records from real calls: the synthetic probes above use fixed ids.
const isRealCall = (r) => /^call-[0-9a-f-]{36}$/.test(String(r.correlation_id));
const recent = (diagnostics.recent ?? []).filter(isRealCall);
const finish = recent.filter((r) => r.phase === 'handler_completed' || r.phase === 'handler_failed');
check('finish receipts exist', finish.length >= 1, recent.length);
const target = finish[finish.length - 1];
const span = recent.filter((r) => r.correlation_id === target.correlation_id);
check('the same call has received + started + finished under one id', span.length >= 3
  && span.some((r) => r.phase === 'http_received')
  && span.some((r) => r.phase === 'handler_started')
  && span.some((r) => r.phase === 'handler_completed' || r.phase === 'handler_failed'), span.map((r) => r.phase));
check('that id is the one the client received', ok1.correlationId === target.correlation_id
  || bad.correlationId === target.correlation_id, { client: [ok1.correlationId, bad.correlationId], log: target.correlation_id });
check('the failing call also has a full span under one id', (() => {
  const failedFinish = recent.find((r) => r.phase === 'handler_failed');
  if (failedFinish === undefined) return false;
  const fspan = recent.filter((r) => r.correlation_id === failedFinish.correlation_id);
  return fspan.some((r) => r.phase === 'http_received') && fspan.some((r) => r.phase === 'handler_started');
})(), recent.filter((r) => r.phase === 'handler_failed'));
// Distinct calls must not share an id.
const ids = [...new Set(recent.map((r) => r.correlation_id))];
check('distinct calls have distinct correlation ids', ids.length >= 2, ids.length);
check('every record has UTC timestamp, method and phase', recent.every((r) => typeof r.at === 'string' && typeof r.method === 'string' && typeof r.phase === 'string'), recent[0]);
check('no record carries arguments or message text', recent.every((r) => !('arguments' in r) && !('message' in r) && !('text' in r)), recent[0]);

await client.close();
await handle.close();
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
process.exit(failures === 0 ? 0 : 1);

#!/usr/bin/env node
/**
 * A JSON-RPC batch must not collapse every call onto one correlation id.
 *
 * Sends two tools/call messages in ONE POST body and asserts that each response
 * carries its own id and that both ids have their own complete
 * http_received/handler span. `enterWith` in a loop would leave only the last id
 * visible to both handlers, which is exactly what this catches.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpServer } from '../../lib/http.js';
import { createMcpServer } from '../../lib/mcp.js';

const TOKEN = 'correlation-batch-token';
const log = { debug() {}, info() {}, warn() {}, error() {} };
let failures = 0;
const check = (n, ok, d) => { console.log(`${ok ? 'OK  ' : 'FAIL'}  ${n}${ok ? '' : `  -> ${JSON.stringify(d)}`}`); if (!ok) failures += 1; };

const handle = await startHttpServer(
  () => createMcpServer({}, { resultMaxChars: 100, resultMaxItems: 10, sessionMaxItems: 5, sessionMaxChars: 100 }, log),
  { host: '127.0.0.1', port: 0, authMode: 'token', authToken: TOKEN },
  log,
);
const client = new Client({ name: 'batch', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
  requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
});
await client.connect(transport);

// Establish a session with a normal initialize, then send ONE POST carrying a
// two-message JSON-RPC batch using the same session id.
const initRes = await fetch(handle.url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'b', version: '1' } } }),
});
const sessionId = initRes.headers.get('mcp-session-id') ?? '';
check('the listener issued a session id', sessionId !== '', sessionId);
await initRes.text();
await fetch(handle.url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}`, 'mcp-session-id': sessionId },
  body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
});

const batch = [
  { jsonrpc: '2.0', id: 101, method: 'tools/call', params: { name: 'dsh_health', arguments: {} } },
  { jsonrpc: '2.0', id: 102, method: 'tools/call', params: { name: 'dsh_list_workspaces', arguments: {} } },
];
const res = await fetch(handle.url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}`, 'mcp-session-id': sessionId },
  body: JSON.stringify(batch),
});
const raw = await res.text();
const payloads = raw.split('\n').filter((l) => l.trim().startsWith('{') || l.trim().startsWith('data:')).map((l) => {
  try { return JSON.parse(l.replace(/^data: /, '')); } catch { return null; }
}).filter(Boolean);
const results = payloads.filter((p) => p.id === 101 || p.id === 102);
check('the batch returned a response per message', results.length === 2, { got: results.map((r) => r.id), raw: raw.slice(0, 200) });

const ids = results.map((r) => r.result?._meta?.['dsh/correlation_id'] ?? r.result?.correlation_id);
check('each batch response carries a correlation id', ids.length === 2 && ids.every((i) => typeof i === 'string'), ids);
check('the two batch ids are DISTINCT (no ALS collapse)', new Set(ids).size === ids.length && ids.length > 0, ids);

// Read the receipts back and confirm each id owns its own complete span.
const snap = await client.callTool({ name: 'dsh_health', arguments: {} });
const parsed = JSON.parse(snap.content.find((p) => p.type === 'text').text);
const recent = (parsed.call_diagnostics?.recent ?? []).filter((r) => /^call-[0-9a-f-]{36}$/.test(String(r.correlation_id)));
for (const id of ids) {
  const span = recent.filter((r) => r.correlation_id === id).map((r) => r.phase);
  check(`id ${String(id).slice(0, 13)}… has receive+start+finish`,
    span.includes('http_received') && span.includes('handler_started')
      && (span.includes('handler_completed') || span.includes('handler_failed')), span);
}

await client.close(); await handle.close();
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);

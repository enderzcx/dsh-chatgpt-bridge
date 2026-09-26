#!/usr/bin/env node
/**
 * Concurrent calls must not share a correlation id.
 *
 * Two MCP sessions (separate transports and server instances) issue overlapping
 * calls. Each response's correlation id must map to exactly one complete
 * receive/start/finish span, and no id may appear in more than one session's
 * span. This is the failure mode a global "current call" variable would produce.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpServer } from '../../lib/http.js';
import { createMcpServer } from '../../lib/mcp.js';

const TOKEN = 'correlation-concurrency-token';
const log = { debug() {}, info() {}, warn() {}, error() {} };
let failures = 0;
const check = (n, ok, d) => { console.log(`${ok ? 'OK  ' : 'FAIL'}  ${n}${ok ? '' : `  -> ${JSON.stringify(d)}`}`); if (!ok) failures += 1; };

const handle = await startHttpServer(
  () => createMcpServer({}, { resultMaxChars: 100, resultMaxItems: 10, sessionMaxItems: 5, sessionMaxChars: 100 }, log),
  { host: '127.0.0.1', port: 0, authMode: 'token', authToken: TOKEN },
  log,
);
const connect = async () => {
  const client = new Client({ name: 'conc', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(handle.url), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  }));
  return client;
};
const a = await connect();
const b = await connect();

const call = async (client, name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { id: r.correlation_id, meta: r._meta?.['dsh/correlation_id'], isError: r.isError === true };
};

// Overlapping calls across two sessions, interleaved.
const [r1, r2, r3, r4] = await Promise.all([
  call(a, 'dsh_health', {}),
  call(b, 'dsh_health', {}),
  call(a, 'dsh_list_workspaces', {}),
  call(b, 'dsh_health', {}),
]);
const all = [r1, r2, r3, r4];
check('every concurrent call returned a correlation id', all.every((r) => typeof r.id === 'string' && r.id.startsWith('call-')), all.map((r) => r.id));
check('_meta carries the same id as the top-level field', all.every((r) => r.meta === r.id), all.map((r) => [r.id, r.meta]));
check('all four ids are distinct (no crosstalk)', new Set(all.map((r) => r.id)).size === 4, all.map((r) => r.id));

// Each id must own exactly one receive/start/finish span.
const diagnostics = (await call(a, 'dsh_health', {})).id;
const snap = await call(a, 'dsh_health', {});
const health = await a.callTool({ name: 'dsh_health', arguments: {} });
const parsed = JSON.parse(health.content.find((p) => p.type === 'text').text);
const recent = (parsed.call_diagnostics?.recent ?? []).filter((r) => /^call-[0-9a-f-]{36}$/.test(String(r.correlation_id)));
for (const id of [r1.id, r2.id, r3.id]) {
  const span = recent.filter((r) => r.correlation_id === id);
  const phases = span.map((r) => r.phase);
  check(`call ${id.slice(0, 13)}… has one receive+start+finish span`, phases.includes('http_received')
    && phases.includes('handler_started')
    && (phases.includes('handler_completed') || phases.includes('handler_failed')), phases);
}
// No id may hold more than one http_received (that would be a reused id).
const receivedCounts = new Map();
for (const r of recent) if (r.phase === 'http_received') receivedCounts.set(r.correlation_id, (receivedCounts.get(r.correlation_id) ?? 0) + 1);
check('no correlation id was reused for two receipts', [...receivedCounts.values()].every((n) => n === 1), [...receivedCounts.entries()].slice(0, 4));
void diagnostics; void snap;

await a.close(); await b.close(); await handle.close();
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);

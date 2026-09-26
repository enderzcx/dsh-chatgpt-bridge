import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHash } from 'node:crypto';
import { startHttpServer } from '../../lib/http.js';
import { createMcpServer } from '../../lib/mcp.js';
import { callDiagnostics } from '../../lib/diagnostics.js';
const log={debug(){},info(){},warn(){},error(){}};
const TOKEN='fp-check-token';
const handle = await startHttpServer(() => createMcpServer({}, { resultMaxChars:100, resultMaxItems:10, sessionMaxItems:5, sessionMaxChars:100 }, log),
  { host:'127.0.0.1', port:0, authMode:'token', authToken:TOKEN }, log);
const client = new Client({ name:'fp', version:'1' });
await client.connect(new StreamableHTTPClientTransport(new URL(handle.url), { requestInit:{ headers:{ Authorization:`Bearer ${TOKEN}` } } }));
const { tools } = await client.listTools();
// Recompute the fingerprint from the REAL tools/list payload, independently.
// Canonicalise (sorted keys) exactly as the bridge does, so the comparison tests
// the contract rather than object construction order.
const canon = (v) => {
  const walk = (n) => Array.isArray(n) ? n.map(walk)
    : (n !== null && typeof n === 'object'
      ? Object.fromEntries(Object.keys(n).sort().map(k => [k, walk(n[k])]))
      : n);
  return JSON.stringify(walk(v));
};
const material = [...tools].map(t => canon({
  name: t.name, title: t.title ?? null, description: t.description ?? '',
  inputSchema: t.inputSchema ?? null, annotations: t.annotations ?? null,
  execution: t.execution ?? null,
})).sort();
const expected = createHash('sha256').update(material.join('\n')).digest('hex');
const published = callDiagnostics.snapshot(1).tool_surface;
console.log('tools/list count     :', tools.length);
console.log('published count      :', published?.count);
console.log('published sha256     :', published?.sha256);
console.log('recomputed sha256    :', expected);
console.log('MATCH                :', published?.sha256 === expected && published?.count === tools.length);
const sample = tools.find(t=>t.name==='dsh_start_goal');
console.log('wire schema is JSON  :', !!(sample.inputSchema && sample.inputSchema.type === 'object'));
console.log('wire schema props    :', Object.keys(sample.inputSchema?.properties ?? {}).length);
await client.close(); await handle.close();
process.exit(published?.sha256 === expected ? 0 : 1);

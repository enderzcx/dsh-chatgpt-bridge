/**
 * The call receipts must be bounded, allowlisted, and free of caller data.
 *
 * The critical property is that allowlists — not string shapes — decide what is
 * stored. A synthetic secret is fed in as an unknown tool name, an unknown
 * method, a crafted error `code`, and an error message; none of it may appear in
 * a record or in the read-only diagnostics view. A genuine business code such as
 * VERSION_CONFLICT must survive, so the guard is not simply erasing everything.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CallDiagnostics, UNREGISTERED_TOOL, UNKNOWN_METHOD } from '../../lib/diagnostics.js';
import { isKnownErrorCode, BRIDGE_ERROR_CODES, DIRECT_OPS_ERROR_CODES, CODEX_CLIENT_ERROR_CODES } from '../../lib/error-codes.js';

const SECRET = 'sk-live-SUPERSECRET-abcdef1234567890';
const SECRET2 = 'AKIA-SECRET-ACCESS-KEY-9999';

function fresh(capacity) {
  const diagnostics = new CallDiagnostics(capacity);
  diagnostics.registerTool('dsh_health');
  return diagnostics;
}

test('a registered tool and a served method are stored as-is', () => {
  const d = fresh();
  const id = d.newCorrelationId();
  d.record({ correlationId: id, phase: 'handler_completed', method: 'tools/call', tool: 'dsh_health' });
  const snapshot = d.snapshot(10);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].tool, 'dsh_health');
  assert.equal(snapshot.records[0].method, 'tools/call');
});

test('an unknown tool name is stored as UNREGISTERED, never verbatim', () => {
  const d = fresh();
  const id = d.newCorrelationId();
  d.record({ correlationId: id, phase: 'handler_started', method: 'tools/call', tool: SECRET });
  const record = d.snapshot(10).records[0];
  assert.equal(record.tool, UNREGISTERED_TOOL);
  assert.equal(JSON.stringify(d.snapshot(10)).includes(SECRET), false, 'the secret must not appear anywhere');
  assert.equal(d.coverage().unknown_tools, 1);
});

test('an unknown method is stored as UNKNOWN_METHOD, never verbatim', () => {
  const d = fresh();
  const id = d.newCorrelationId();
  d.record({ correlationId: id, phase: 'http_received', method: SECRET2 });
  const record = d.snapshot(10).records[0];
  assert.equal(record.method, UNKNOWN_METHOD);
  assert.equal(JSON.stringify(d.snapshot(10)).includes(SECRET2), false);
  assert.equal(d.coverage().unknown_methods, 1);
});

test('a crafted error code that merely looks like a code is replaced by UNKNOWN', () => {
  const d = fresh();
  const id = d.newCorrelationId();
  // Uppercase, underscore-shaped, and definitely not one of our codes.
  d.record({ correlationId: id, phase: 'handler_failed', method: 'tools/call', tool: 'dsh_health', errorCode: SECRET });
  const record = d.snapshot(10).records[0];
  assert.equal(record.error_code, 'UNKNOWN');
  assert.equal(JSON.stringify(d.snapshot(10)).includes(SECRET), false);
  assert.equal(d.coverage().unknown_errors, 1);
});

test('a genuine business code is preserved', () => {
  const d = fresh();
  for (const code of ['VERSION_CONFLICT', 'PATH_DENIED', 'MESSAGE_ALREADY_ADMITTED', 'STEER_UNAVAILABLE']) {
    const id = d.newCorrelationId();
    d.record({ correlationId: id, phase: 'handler_failed', method: 'tools/call', tool: 'dsh_health', errorCode: code });
  }
  const codes = d.snapshot(10).records.map((r) => r.error_code);
  assert.deepEqual(codes, ['VERSION_CONFLICT', 'PATH_DENIED', 'MESSAGE_ALREADY_ADMITTED', 'STEER_UNAVAILABLE']);
  assert.equal(d.coverage().unknown_errors, 0, 'a known code must not be counted as unknown');
});

test('codeFor trusts only known codes; an unknown code and message become fixed values', () => {
  const d = fresh();
  assert.equal(d.codeFor(Object.assign(new Error('x'), { code: 'VERSION_CONFLICT' })), 'VERSION_CONFLICT');
  assert.equal(d.codeFor(Object.assign(new Error('x'), { code: SECRET })), 'UNKNOWN');
  // The message is only pattern-matched; it is never stored.
  assert.equal(d.codeFor(new Error(`invalid arguments: ${SECRET}`)), 'INVALID_ARGUMENTS');
  assert.equal(d.codeFor(new Error(`boom ${SECRET}`)), 'INTERNAL');
  assert.equal(JSON.stringify(d.snapshot(10)).includes(SECRET), false);
});

test('the error message of a thrown secret never reaches a record', () => {
  const d = fresh();
  const id = d.newCorrelationId();
  const code = d.codeFor(new Error(`connection to ${SECRET} failed`));
  d.record({ correlationId: id, phase: 'handler_failed', method: 'tools/call', tool: 'dsh_health', errorCode: code });
  const text = JSON.stringify(d.snapshot(10));
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes('connection to'), false, 'no message text is stored');
});

test('records are bounded and drops are counted, never silent', () => {
  const d = fresh(16);
  for (let i = 0; i < 40; i += 1) {
    d.record({ correlationId: d.newCorrelationId(), phase: 'handler_completed', method: 'tools/call', tool: 'dsh_health' });
  }
  const snapshot = d.snapshot(100);
  assert.equal(snapshot.records.length, 16, 'the ring capacity bounds retained records');
  assert.equal(snapshot.coverage.retained, 16);
  assert.equal(snapshot.coverage.dropped, 24, 'every drop is counted');
  assert.equal(snapshot.coverage.persistent, false, 'this is in-memory, not persistent logging');
});

test('recording never throws, even for hostile input', () => {
  const d = fresh();
  const circular = {};
  circular.self = circular;
  assert.doesNotThrow(() => d.record({ correlationId: 'x', phase: 'handler_started', method: 'tools/call', tool: 'dsh_health' }));
  assert.doesNotThrow(() => d.record({ correlationId: 'y', phase: 'handler_completed', method: 'tools/call', tool: SECRET, errorCode: SECRET }));
  // A rejected value must not leave the call without a record.
  assert.equal(d.snapshot(10).records.length, 2);
});

test('correlation ids are unique and records can be looked up by one', () => {
  const d = fresh();
  const a = d.newCorrelationId();
  const b = d.newCorrelationId();
  assert.notEqual(a, b);
  d.record({ correlationId: a, phase: 'http_received', method: 'tools/call', tool: 'dsh_health' });
  d.record({ correlationId: a, phase: 'handler_started', method: 'tools/call', tool: 'dsh_health' });
  d.record({ correlationId: b, phase: 'http_received', method: 'tools/call', tool: 'dsh_health' });
  const span = d.byCorrelationId(a);
  assert.equal(span.length, 2);
  assert.deepEqual(span.map((r) => r.phase), ['http_received', 'handler_started']);
  assert.equal(d.snapshot(10).totals[0].received, 2);
  assert.equal(d.snapshot(10).totals[0].started, 1);
});

test('every error-code literal in src is present in the allowlist', () => {
  const root = new URL('../../src', import.meta.url).pathname;
  const seen = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      const text = readFileSync(full, 'utf8');
      for (const m of text.matchAll(/(?:BridgeError|DirectOpsError)\(\s*'([A-Z][A-Z0-9_]+)'/g)) seen.add(m[1]);
      for (const m of text.matchAll(/new CodexClientError\(\s*'([A-Z][A-Z0-9_]+)'/g)) seen.add(m[1]);
    }
  };
  walk(root);
  assert.ok(seen.size > 20, `expected to find codes, found ${seen.size}`);
  const known = new Set([...BRIDGE_ERROR_CODES, ...DIRECT_OPS_ERROR_CODES, ...CODEX_CLIENT_ERROR_CODES]);
  const missing = [...seen].filter((code) => !known.has(code) && !isKnownErrorCode(code));
  assert.deepEqual(missing, [], 'these thrown codes are missing from the allowlist');
});

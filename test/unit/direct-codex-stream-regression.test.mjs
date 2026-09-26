/** Regression cases from the ChatGPT 0.6.2 live smoke, 2026-09-25. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexAppServerClient } from '../../lib/direct/codex-app-server.js';
import { RunRegistry } from '../../lib/direct/exec-runs.js';

function fakeClient(onOutputDelta, exercise = () => {}) {
  const calls = [];
  const client = new CodexAppServerClient({ binPath: '/unused/codex', env: {}, onOutputDelta });
  // Exercise exec's actual protocol parameter construction, without a model or process.
  client.request = async (method, params) => {
    calls.push(JSON.parse(JSON.stringify({ method, params })));
    exercise(client, params);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { client, calls };
}

test('exec forwards a requested 25-second deadline into command/exec params', async () => {
  const { client, calls } = fakeClient();
  await client.exec({ command: ['node'], timeoutMs: 25000, sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/work'] } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'command/exec');
  assert.equal(calls[0].params.timeoutMs, 25000);
  assert.equal(calls[0].params.disableTimeout, undefined);
});

test('exec forwards an explicit short deadline instead of the server default', async () => {
  const { client, calls } = fakeClient();
  await client.exec({ command: ['node'], timeoutMs: 1500, sandboxPolicy: { type: 'readOnly' } });
  assert.equal(calls[0].params.timeoutMs, 1500);
});

test('internal explicit disableTimeout is forwarded rather than silently ignored', async () => {
  const { client, calls } = fakeClient();
  await client.exec({ command: ['node'], disableTimeout: true, sandboxPolicy: { type: 'readOnly' } });
  assert.equal(calls[0].params.disableTimeout, true);
  assert.equal(calls[0].params.timeoutMs, undefined);
});

function deferredRun(registry) {
  let emit;
  let resolve;
  const result = new Promise((done) => { resolve = done; });
  const initial = registry.start({
    cmd: 'node', argv: ['node'], cwd: '/work', backend: 'codex-app-server',
    sandbox: {}, processId: 'test', maxOutputBytes: 1024,
    run: (onDelta) => {
      emit = onDelta;
      return { result, stop: async () => {}, dispose: async () => {} };
    },
  });
  return { id: initial.run_id, emit, resolve };
}

test('streamed bytes are not appended again from the final cumulative result', async () => {
  const registry = new RunRegistry({ maxRuns: 1, maxOutputBytes: 1024 });
  const run = deferredRun(registry);
  // Identical real chunks must survive; text-based deduplication would be wrong.
  run.emit('stdout', 'same\n', false);
  run.emit('stdout', 'same\n', false);
  run.emit('stderr', 'error 中文🙂\n', false);
  const before = registry.view(run.id);
  run.resolve({ exitCode: 7, stdout: 'same\nsame\n', stderr: 'error 中文🙂\n', timeout: false });
  await registry.get(run.id).promise;
  const after = registry.view(run.id);
  assert.equal(after.stdout, 'same\nsame\n');
  assert.equal(after.stderr, 'error 中文🙂\n');
  assert.equal(after.stdout_bytes, Buffer.byteLength(after.stdout));
  assert.equal(after.stderr_bytes, Buffer.byteLength(after.stderr));
  assert.equal(after.exit_code, 7);
  assert.equal(after.seq, before.seq);
  assert.equal(registry.view(run.id, before.seq).stdout, '');
  assert.equal(registry.view(run.id, before.seq).stderr, '');
});

test('buffered fallback is per stream, retaining an unstreamed stderr', async () => {
  const registry = new RunRegistry({ maxRuns: 1, maxOutputBytes: 1024 });
  const run = deferredRun(registry);
  run.emit('stdout', 'live\n', false);
  run.resolve({ exitCode: 0, stdout: 'live\n', stderr: 'buffered-only\n' });
  await registry.get(run.id).promise;
  assert.equal(registry.view(run.id).stdout, 'live\n');
  assert.equal(registry.view(run.id).stderr, 'buffered-only\n');
});

test('empty streamed cap signal does not replay final output or lose truncation', async () => {
  const registry = new RunRegistry({ maxRuns: 1, maxOutputBytes: 1024 });
  const run = deferredRun(registry);
  run.emit('stdout', '', true);
  run.resolve({ exitCode: 0, stdout: 'cumulative-copy', stderr: '' });
  await registry.get(run.id).promise;
  const view = registry.view(run.id);
  assert.equal(view.stdout, '');
  assert.equal(view.stdout_truncated, true);
});

function notify(client, processId, bytes) {
  client.onNotification('command/exec/outputDelta', { processId, stream: 'stdout', deltaBase64: bytes.toString('base64'), capReached: false });
}

test('live callbacks, not just final aggregation, preserve split UTF-8 characters', async () => {
  const chunks = [];
  const expected = '中文🙂\n';
  const { client } = fakeClient((delta) => chunks.push(delta.text), (self, params) => {
    for (const byte of Buffer.from(expected)) notify(self, params.processId, Buffer.from([byte]));
  });
  const result = await client.exec({ command: ['node'], sandboxPolicy: { type: 'readOnly' }, timeoutMs: 1000 });
  assert.equal(result.stdout, expected);
  assert.equal(chunks.join(''), expected);
});

test('an incomplete final UTF-8 tail is flushed consistently to live and final output', async () => {
  const chunks = [];
  const { client } = fakeClient((delta) => chunks.push(delta.text), (self, params) => notify(self, params.processId, Buffer.from([0xf0])));
  const result = await client.exec({ command: ['node'], sandboxPolicy: { type: 'readOnly' }, timeoutMs: 1000 });
  assert.equal(result.stdout, '\uFFFD');
  assert.equal(chunks.join(''), result.stdout);
});

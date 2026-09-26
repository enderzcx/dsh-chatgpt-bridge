/**
 * Unit tests for the codex-app-server execution backend.
 *
 * These are pure: they exercise the permission translation, the JSON-RPC client
 * guard, the async run registry and the policy self-description without starting
 * a real codex process. The live behaviour (real commands, real sandbox
 * denials, streaming, terminate) is covered by the isolated end-to-end harness
 * recorded under the task's persistent delivery directory, because it needs the
 * installed codex binary.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { planCodexSandbox, resolveCodexBinary } from '../../lib/direct/codex-backend.js';
import { runCommand, resolveCwd } from '../../lib/direct/exec.js';
import { resolveDirectOpsPolicy, resolveAllowedCommand } from '../../lib/direct/policy.js';
import { CodexAppServerClient } from '../../lib/direct/codex-app-server.js';
import { RunRegistry } from '../../lib/direct/exec-runs.js';
import { createMcpServer } from '../../lib/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpServer } from '../../lib/http.js';
import { DirectOpsError } from '../../lib/direct/types.js';
import { makeSandbox, policyFor } from '../helpers/direct-harness.mjs';

/** The direct surface's error code for a rejected call, or null when it resolved. */
async function codeOf(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof DirectOpsError) return error.code;
    throw error;
  }
}

// ── permission translation: the policy is the ceiling ─────────────────────────

test('codex plan: no configured write roots yields readOnly, never a write grant', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox, {}, {
      enabled: true,
      allowedCommands: ['sh'],
      writableRoots: [],
      network: 'deny',
      filesystem: 'roots',
      backend: 'codex-app-server',
      codexBin: '/nonexistent/codex',
    });
    // Strip the write roots the helper defaults in, to model an operator who
    // enabled exec but granted no write path.
    const readOnlyPolicy = { ...policy, exec: { ...policy.exec, writableRoots: [] } };
    const plan = planCodexSandbox(readOnlyPolicy, sandbox.root);
    assert.equal(plan.policy.type, 'readOnly');
    assert.equal(plan.describe.codex_policy, 'readOnly');
    assert.equal(plan.describe.write_scope, 'none');
  } finally {
    await sandbox.cleanup();
  }
});

test('codex plan: configured write roots become workspaceWrite with exactly those roots', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox, {}, {
      enabled: true,
      allowedCommands: ['sh'],
      writableRoots: [sandbox.root],
      network: 'deny',
      filesystem: 'roots',
      backend: 'codex-app-server',
      codexBin: '/nonexistent/codex',
    });
    const plan = planCodexSandbox(policy, sandbox.root);
    assert.equal(plan.policy.type, 'workspaceWrite');
    assert.deepEqual(plan.policy.writableRoots, [sandbox.root]);
    assert.match(String(plan.describe.write_scope), /only the configured exec\.writableRoots/);
    // Measured on the installed codex: workspaceWrite also grants $TMPDIR and
    // /tmp unless both exclude flags are set, so they are part of the plan.
    assert.equal(plan.policy.excludeTmpdirEnvVar, true);
    assert.equal(plan.policy.excludeSlashTmp, true);
    assert.equal(plan.describe.temp_writes, 'excluded');
    // The honest read statement: codex's modes permit broad reads.
    assert.match(String(plan.describe.read_scope), /not confined to trusted roots/);
    assert.equal(plan.describe.cwd_grants_writes, false);
  } finally {
    await sandbox.cleanup();
  }
});

test('codex plan: network=allow is carried through, deny is the default direction', async () => {
  const sandbox = await makeSandbox();
  try {
    const base = {
      enabled: true,
      allowedCommands: ['sh'],
      writableRoots: [sandbox.root],
      filesystem: 'roots',
      backend: 'codex-app-server',
      codexBin: '/nonexistent/codex',
      network: 'deny',
    };
    const denied = planCodexSandbox(policyFor(sandbox, {}, base), sandbox.root);
    assert.equal(denied.policy.networkAccess, false);
    const allowed = planCodexSandbox(policyFor(sandbox, {}, { ...base, network: 'allow' }), sandbox.root);
    assert.equal(allowed.policy.networkAccess, true);
  } finally {
    await sandbox.cleanup();
  }
});

test('codex plan: filesystem=inherit is refused instead of widened to full access', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox, {}, {
      enabled: true,
      allowedCommands: ['sh'],
      writableRoots: [sandbox.root],
      network: 'deny',
      filesystem: 'inherit',
      backend: 'codex-app-server',
      codexBin: '/nonexistent/codex',
    });
    assert.equal(await codeOf(Promise.resolve().then(() => planCodexSandbox(policy, sandbox.root))), 'CODEX_POLICY_UNSUPPORTED');
  } finally {
    await sandbox.cleanup();
  }
});

test('codex backend: an unset codexBin is refused, never guessed from PATH', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox, {}, {
      enabled: true,
      allowedCommands: ['sh'],
      writableRoots: [sandbox.root],
      network: 'deny',
      filesystem: 'roots',
      backend: 'codex-app-server',
    });
    // Empty string is the "unset" representation, because the public schema
    // cannot carry `undefined` through its defaults.
    assert.equal(policy.exec.codexBin, '');
    assert.equal(await codeOf(Promise.resolve().then(() => resolveCodexBinary(policy))), 'CODEX_BIN_UNCONFIGURED');
  } finally {
    await sandbox.cleanup();
  }
});

test('codex backend: an invalid backend value is a configuration error', async () => {
  const sandbox = await makeSandbox();
  try {
    assert.throws(
      () => policyFor(sandbox, {}, { enabled: true, allowedCommands: ['sh'], backend: 'codex-cli' }),
      (error) => error instanceof DirectOpsError && error.code === 'INVALID_ARGUMENT',
    );
  } finally {
    await sandbox.cleanup();
  }
});

test('codex backend: the default backend stays the local sandbox path', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox, {}, { enabled: true, allowedCommands: ['sh'] });
    assert.equal(policy.exec.backend, 'sandbox-exec');
    assert.deepEqual(policy.exec.codexArgs, []);
  } finally {
    await sandbox.cleanup();
  }
});

// ── the client refuses anything thread/turn shaped ───────────────────────────

test('codex client: thread and turn methods are refused by code', async () => {
  const client = new CodexAppServerClient({ binPath: '/nonexistent/codex', env: { PATH: '/usr/bin:/bin' } });
  for (const method of ['thread/start', 'thread/resume', 'turn/start', 'turn/interrupt', 'review/start']) {
    await assert.rejects(
      // The guard runs before any process exists, so this needs no app server.
      () => client['request'](method, {}, 100),
      (error) => error.code === 'CODEX_METHOD_NOT_ALLOWED',
      `${method} must be refused`,
    );
  }
  assert.deepEqual(client.sentMethods, [], 'a refused method must never reach the wire');
});

test('codex client: exec with an empty argv is refused before spawning', async () => {
  const client = new CodexAppServerClient({ binPath: '/nonexistent/codex', env: { PATH: '/usr/bin:/bin' } });
  await assert.rejects(
    () => client.exec({ command: [], sandboxPolicy: { type: 'readOnly' } }),
    (error) => error.code === 'CODEX_EMPTY_COMMAND',
  );
});

test('codex client: a request on a never-started client fails closed', async () => {
  const client = new CodexAppServerClient({ binPath: '/nonexistent/codex', env: { PATH: '/usr/bin:/bin' } });
  await assert.rejects(
    () => client['request']('initialize', {}, 100),
    (error) => error.code === 'CODEX_NOT_RUNNING',
  );
});

// ── async run registry bounds ────────────────────────────────────────────────

function registryRun(result, options = {}) {
  return {
    result: options.result ?? Promise.resolve(result),
    stop: options.stop ?? (async () => {}),
    dispose: async () => {},
  };
}

test('runs: start returns immediately and later reads see the output', async () => {
  const registry = new RunRegistry({ maxRuns: 2, maxOutputBytes: 1024 });
  let emit;
  const view = registry.start({
    cmd: 'sh',
    argv: ['sh', '-c', 'echo hi'],
    cwd: '/tmp',
    backend: 'codex-app-server',
    sandbox: { codex_policy: 'readOnly' },
    processId: 'p1',
    maxOutputBytes: 1024,
    run: (onDelta) => {
      emit = onDelta;
      return registryRun({ exitCode: 0, stdout: '', stderr: '' });
    },
  });
  assert.equal(view.status, 'running');
  assert.equal(view.stdout, '');
  emit('stdout', 'hello ', false);
  emit('stdout', 'world', false);
  const after = registry.view(view.run_id, 0);
  assert.equal(after.stdout, 'hello world');
  assert.equal(after.seq, 2);
});

test('runs: since_seq returns only newer chunks', async () => {
  const registry = new RunRegistry({ maxRuns: 2, maxOutputBytes: 1024 });
  let emit;
  const view = registry.start({
    cmd: 'sh', argv: ['sh'], cwd: '/tmp', backend: 'b', sandbox: {}, processId: 'p', maxOutputBytes: 1024,
    run: (onDelta) => { emit = onDelta; return registryRun({ exitCode: 0, stdout: '', stderr: '' }); },
  });
  emit('stdout', 'first', false);
  const one = registry.view(view.run_id, 0);
  emit('stdout', 'second', false);
  const two = registry.view(view.run_id, one.seq);
  assert.equal(two.stdout, 'second');
  assert.equal(registry.view(view.run_id, 0).stdout, 'firstsecond');
});

test('runs: output is bounded and truncation is reported', async () => {
  const registry = new RunRegistry({ maxRuns: 1, maxOutputBytes: 1024 });
  let emit;
  const view = registry.start({
    cmd: 'sh', argv: ['sh'], cwd: '/tmp', backend: 'b', sandbox: {}, processId: 'p', maxOutputBytes: 1024,
    run: (onDelta) => { emit = onDelta; return registryRun({ exitCode: 0, stdout: '', stderr: '' }); },
  });
  emit('stdout', 'x'.repeat(4096), false);
  const out = registry.view(view.run_id, 0);
  assert.ok(out.stdout.length <= 1024, out.stdout.length);
  assert.equal(out.stdout_truncated, true);
});

test('runs: the concurrency bound refuses a new run', async () => {
  const registry = new RunRegistry({ maxRuns: 1, maxOutputBytes: 1024 });
  const never = new Promise(() => {});
  registry.start({
    cmd: 'sh', argv: ['sh'], cwd: '/tmp', backend: 'b', sandbox: {}, processId: 'p1', maxOutputBytes: 1024,
    run: () => ({ result: never, stop: async () => {}, dispose: async () => {} }),
  });
  assert.equal(await codeOf(Promise.resolve().then(() => registry.start({
    cmd: 'sh', argv: ['sh'], cwd: '/tmp', backend: 'b', sandbox: {}, processId: 'p2', maxOutputBytes: 1024,
    run: () => ({ result: never, stop: async () => {}, dispose: async () => {} }),
  }))), 'RUN_LIMIT_REACHED');
});

test('runs: an unknown run_id is refused', () => {
  const registry = new RunRegistry({ maxRuns: 1, maxOutputBytes: 1024 });
  assert.throws(() => registry.view('run-nope', 0), (error) => error.code === 'RUN_NOT_FOUND');
});

test('runs: a 124 exit is a timeout only when the runner says so', async () => {
  const registry = new RunRegistry({ maxRuns: 1, maxOutputBytes: 1024 });
  const view = registry.start({
    cmd: 'sh', argv: ['sleep'], cwd: '/tmp', backend: 'b', sandbox: {}, processId: 'p', maxOutputBytes: 1024,
    run: () => registryRun({ exitCode: 124, stdout: '', stderr: '', timeout: true, timeoutEvidence: 'wall-time-near-deadline' }),
  });
  await new Promise((r) => setTimeout(r, 20));
  const out = registry.view(view.run_id, 0);
  assert.equal(out.status, 'exited');
  assert.equal(out.exit_code, 124);
  assert.equal(out.timed_out, true);
  assert.equal(out.timeout_evidence, 'wall-time-near-deadline');
});

test('runs: a command that exits 124 by itself keeps its code and is not a timeout', async () => {
  const registry = new RunRegistry({ maxRuns: 1, maxOutputBytes: 1024 });
  const view = registry.start({
    cmd: 'sh', argv: ['exit-124'], cwd: '/tmp', backend: 'b', sandbox: {}, processId: 'p', maxOutputBytes: 1024,
    // The adapter reports timeout=false for a self-chosen 124.
    run: () => registryRun({ exitCode: 124, stdout: '', stderr: '', timeout: false, timeoutEvidence: 'none' }),
  });
  await new Promise((r) => setTimeout(r, 20));
  const out = registry.view(view.run_id, 0);
  assert.equal(out.exit_code, 124, 'the raw exit code must survive');
  assert.equal(out.timed_out, false, 'a self-chosen 124 must not be called a timeout');
  assert.equal(out.timeout_evidence, 'none');
});

test('runs: a stop request does not mark a run terminated before its process is gone', async () => {
  const registry = new RunRegistry({ maxRuns: 1, maxOutputBytes: 1024 });
  let resolveRun;
  const view = registry.start({
    cmd: 'sh', argv: ['sleep'], cwd: '/tmp', backend: 'b', sandbox: {}, processId: 'p', maxOutputBytes: 1024,
    run: () => ({ result: new Promise((r) => { resolveRun = r; }), stop: async () => {}, dispose: async () => {} }),
  });
  registry.markStopRequested(view.run_id);
  // The request alone must not free the slot or claim termination.
  assert.equal(registry.view(view.run_id, 0).status, 'running');
  assert.equal(registry.liveCount(), 1);
  resolveRun({ exitCode: 0, stdout: '', stderr: '' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(registry.view(view.run_id, 0).status, 'terminated');
});

test('runs: an empty delta carrying capReached still records truncation', async () => {
  const registry = new RunRegistry({ maxRuns: 1, maxOutputBytes: 1024 });
  let emit;
  const view = registry.start({
    cmd: 'sh', argv: ['sh'], cwd: '/tmp', backend: 'b', sandbox: {}, processId: 'p', maxOutputBytes: 1024,
    run: (onDelta) => { emit = onDelta; return registryRun({ exitCode: 0, stdout: '', stderr: '' }); },
  });
  emit('stdout', '', true);
  const out = registry.view(view.run_id, 0);
  assert.equal(out.stdout_truncated, true, 'capReached on an empty final delta must not be lost');
  assert.equal(out.stdout, '');
});

test('runs: a multibyte chunk is cut on a character boundary and within the byte budget', async () => {
  const registry = new RunRegistry({ maxRuns: 1, maxOutputBytes: 1024 });
  let emit;
  const view = registry.start({
    cmd: 'sh', argv: ['sh'], cwd: '/tmp', backend: 'b', sandbox: {}, processId: 'p', maxOutputBytes: 10,
    run: (onDelta) => { emit = onDelta; return registryRun({ exitCode: 0, stdout: '', stderr: '' }); },
  });
  // 4-byte emoji: a 10-byte budget holds exactly two of them.
  emit('stdout', '😀😀😀', false);
  const out = registry.view(view.run_id, 0);
  assert.ok(Buffer.byteLength(out.stdout, 'utf8') <= 10, `kept ${Buffer.byteLength(out.stdout, 'utf8')} bytes`);
  assert.equal(out.stdout.includes('\uFFFD'), false, 'no character may be split');
  assert.equal(out.stdout, '😀😀');
  assert.equal(out.stdout_truncated, true);
});

test('runs: the per-run byte budget is respected, not the registry default', async () => {
  const registry = new RunRegistry({ maxRuns: 1, maxOutputBytes: 100000 });
  let emit;
  const view = registry.start({
    cmd: 'sh', argv: ['sh'], cwd: '/tmp', backend: 'b', sandbox: {}, processId: 'p', maxOutputBytes: 2048,
    run: (onDelta) => { emit = onDelta; return registryRun({ exitCode: 0, stdout: '', stderr: '' }); },
  });
  emit('stdout', 'x'.repeat(5000), false);
  const out = registry.view(view.run_id, 0);
  assert.equal(out.stdout.length, 2048, 'the run budget, not the registry default, applies');
  assert.equal(out.stdout_truncated, true);
});

test('runs: a failing run is reported as failed with its error, not as success', async () => {
  const registry = new RunRegistry({ maxRuns: 1, maxOutputBytes: 1024 });
  const view = registry.start({
    cmd: 'sh', argv: ['sh'], cwd: '/tmp', backend: 'b', sandbox: {}, processId: 'p', maxOutputBytes: 1024,
    run: () => ({ result: Promise.reject(new Error('boom')), stop: async () => {}, dispose: async () => {} }),
  });
  await new Promise((r) => setTimeout(r, 20));
  const out = registry.view(view.run_id, 0);
  assert.equal(out.status, 'failed');
  assert.match(String(out.error), /boom/);
});

// ── policy self-description tells the truth about the backend ───────────────

test('policy view: the codex backend is reported as its own sandbox kind', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox, {}, {
      enabled: true,
      allowedCommands: ['sh'],
      writableRoots: [sandbox.root],
      network: 'deny',
      filesystem: 'roots',
      sandbox: 'required',
      backend: 'codex-app-server',
      codexBin: '/nonexistent/codex',
    });
    const server = createMcpServer({}, { resultMaxChars: 100, resultMaxItems: 10, sessionMaxItems: 5, sessionMaxChars: 100 }, { debug() {}, info() {}, warn() {}, error() {} });
    assert.ok(server, 'server builds');
    const { describePolicy } = await import('../../lib/direct/tools.js');
    const view = describePolicy(policy, { policy: () => policy, reload: () => policy, reloadable: false });
    assert.equal(view.exec_backend, 'codex-app-server');
    assert.equal(view.sandbox_kind, 'codex-app-server');
    assert.equal(view.sandbox_available, true, 'a configured executable is what makes the codex sandbox usable');
    assert.equal(view.async_runs, true);
    assert.deepEqual(view.command_writable_roots, [sandbox.root]);
    assert.ok(
      view.notes.some((note) => /do NOT confine command reads|not.*inherited/i.test(note)),
      `read scope must be stated honestly: ${JSON.stringify(view.notes)}`,
    );
  } finally {
    await sandbox.cleanup();
  }
});

test('policy view: an unconfigured codex binary is reported as unavailable', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox, {}, {
      enabled: true,
      allowedCommands: ['sh'],
      network: 'deny',
      filesystem: 'roots',
      backend: 'codex-app-server',
    });
    const { describePolicy } = await import('../../lib/direct/tools.js');
    const view = describePolicy(policy, { policy: () => policy, reload: () => policy, reloadable: false });
    assert.equal(view.sandbox_available, false);
    assert.ok(view.notes.some((note) => /refused, not run unsandboxed/.test(note)), JSON.stringify(view.notes));
  } finally {
    await sandbox.cleanup();
  }
});

test('direct surface: the async command tools are advertised and read-only ones are honest', async () => {
  const sandbox = await makeSandbox();
  const TOKEN = 'test-token-codex-backend';
  let handle;
  let client;
  try {
    const { createDirectOpsRuntime } = await import('../../lib/direct/tools.js');
    const runtime = createDirectOpsRuntime({
      enabled: true,
      roots: [sandbox.root],
      writableRoots: [sandbox.root],
      exec: {
        enabled: true,
        allowedCommands: ['sh'],
        cwdRoots: [sandbox.root],
        writableRoots: [sandbox.root],
        network: 'deny',
        filesystem: 'roots',
        backend: 'codex-app-server',
        codexBin: '/nonexistent/codex',
      },
    });
    const log = { debug() {}, info() {}, warn() {}, error() {} };
    handle = await startHttpServer(
      () => createMcpServer(
        {},
        { resultMaxChars: 100, resultMaxItems: 10, sessionMaxItems: 5, sessionMaxChars: 100 },
        log,
        runtime,
      ),
      { host: '127.0.0.1', port: 0, authMode: 'token', authToken: TOKEN },
      log,
    );
    client = new Client({ name: 'codex-backend-surface', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(handle.url), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    }));

    // The wire schema is what a host actually sees, so assert it over MCP.
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of ['dsh_start_command', 'dsh_read_command_output', 'dsh_terminate_command']) {
      assert.ok(byName.has(name), `${name} must be advertised when direct ops are mounted`);
    }
    // Reading a run's output must not be advertised as dangerous or as a write.
    assert.equal(byName.get('dsh_read_command_output').annotations.readOnlyHint, true);
    assert.equal(byName.get('dsh_read_command_output').annotations.destructiveHint, false);
    // Starting and stopping a process must not be advertised as read-only.
    assert.equal(byName.get('dsh_start_command').annotations.readOnlyHint, false);
    assert.equal(byName.get('dsh_start_command').annotations.destructiveHint, true);
    assert.equal(byName.get('dsh_terminate_command').annotations.readOnlyHint, false);
    // Compatibility: the original synchronous tool keeps its exact parameters.
    const params = Object.keys(byName.get('dsh_run_command').inputSchema.properties).sort();
    assert.equal(params.join(','), 'args,cmd,cwd,env,max_output_bytes,timeout_ms');
    // And its description must no longer overstate the sandbox.
    assert.match(byName.get('dsh_run_command').description, /exec\.writableRoots|confines writes/i);
  } finally {
    await client?.close();
    await handle?.close();
    await sandbox.cleanup();
  }
});

// ── exec.cwdRoots is its own boundary, narrower than the trusted roots ────────

test('cwd: a directory inside a trusted root but outside exec.cwdRoots is refused', async () => {
  const sandbox = await makeSandbox();
  try {
    // Two trusted roots, but command execution is scoped to only one of them.
    const policy = resolveDirectOpsPolicy({
      enabled: true,
      roots: [sandbox.root, sandbox.outside],
      allowWrites: true,
      writableRoots: [sandbox.root],
      exec: {
        enabled: true,
        allowedCommands: ['pwd'],
        cwdRoots: [sandbox.root],
        writableRoots: [sandbox.root],
        network: 'deny',
        filesystem: 'roots',
        sandbox: 'required',
        // The local sandbox path keeps this test independent of codex and of
        // whether the host has an OS sandbox at all.
        backend: 'sandbox-exec',
      },
    });
    // A refused cwd throws synchronously, before any process exists.
    let outsideCode = null;
    try {
      await runCommand({ cmd: 'pwd', cwd: sandbox.outside }, policy);
    } catch (error) {
      outsideCode = error.code;
    }
    assert.equal(outsideCode, 'PATH_OUTSIDE_ROOTS', 'a trusted root outside exec.cwdRoots must not be usable as a cwd');
    // The configured cwd root is still accepted by the boundary check, even if
    // the host then has no OS sandbox to run it in.
    let insideCode = null;
    try {
      await runCommand({ cmd: 'pwd', cwd: sandbox.root }, policy);
    } catch (error) {
      insideCode = error.code;
    }
    assert.notEqual(insideCode, 'PATH_OUTSIDE_ROOTS');
  } finally {
    await sandbox.cleanup();
  }
});

// ── measured isolation: cwd and temp are not silently writable ───────────────

test('codex plan: cwd is never a write grant and temp writes are excluded', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox, {}, {
      enabled: true,
      allowedCommands: ['sh'],
      writableRoots: [sandbox.root],
      network: 'deny',
      filesystem: 'roots',
      backend: 'codex-app-server',
      codexBin: '/nonexistent/codex',
    });
    // The cwd deliberately differs from the configured write root.
    const plan = planCodexSandbox(policy, sandbox.outside);
    assert.equal(plan.policy.type, 'workspaceWrite');
    assert.deepEqual(plan.policy.writableRoots, [sandbox.root], 'only the configured root is writable');
    assert.equal(plan.describe.cwd_grants_writes, false);
    assert.equal(plan.describe.cwd, sandbox.outside);
    // Measured on the installed codex: without these two flags a workspaceWrite
    // command can write into $TMPDIR and /tmp even though neither is a
    // writableRoot. They are part of the isolation, so they must always be set.
    assert.equal(plan.policy.excludeTmpdirEnvVar, true);
    assert.equal(plan.policy.excludeSlashTmp, true);
    assert.equal(plan.describe.temp_writes, 'excluded');
  } finally {
    await sandbox.cleanup();
  }
});

test('codex plan: readOnly is reported as unverified rather than trusted', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = { ...policyFor(sandbox, {}, { enabled: true, allowedCommands: ['sh'], network: 'deny', filesystem: 'roots', backend: 'codex-app-server', codexBin: '/nonexistent/codex' }) };
    const readOnlyPolicy = { ...policy, exec: { ...policy.exec, writableRoots: [] } };
    const plan = planCodexSandbox(readOnlyPolicy, sandbox.root);
    assert.equal(plan.policy.type, 'readOnly');
    // Every readOnly command failed with a Seatbelt violation on this host, so
    // the plan must not claim the mode was proven to work.
    assert.equal(plan.describe.verified, 'unverified-on-this-host');
  } finally {
    await sandbox.cleanup();
  }
});

test('codex env: a configured codexHome isolates the child from the user config', async () => {
  const sandbox = await makeSandbox();
  try {
    const home = join(sandbox.base, 'codex-home');
    const policy = policyFor(sandbox, {}, {
      enabled: true,
      allowedCommands: ['sh'],
      writableRoots: [sandbox.root],
      network: 'deny',
      filesystem: 'roots',
      backend: 'codex-app-server',
      codexBin: '/nonexistent/codex',
      codexHome: home,
    });
    const { buildCodexEnv } = await import('../../lib/direct/secrets.js');
    const env = buildCodexEnv(policy);
    assert.equal(env.CODEX_HOME, home, 'the child must be pointed away from the user ~/.codex');
    // Measured: without CODEX_HOME the child reported codexHome=<user home>/.codex,
    // i.e. the user's global config.toml was in effect.
    assert.ok(!env.CODEX_HOME.includes(`${process.env.HOME}/.codex`), env.CODEX_HOME);
  } finally {
    await sandbox.cleanup();
  }
});

// ── administrator full-access mode ───────────────────────────────────────────

test('full access: off by default and only a literal boolean enables it', async () => {
  const sandbox = await makeSandbox();
  try {
    const off = policyFor(sandbox, {}, { enabled: true, allowedCommands: ['sh'], backend: 'codex-app-server', codexBin: '/nonexistent/codex' });
    assert.equal(off.exec.fullAccess, false, 'the default must stay restricted');
    const on = policyFor(sandbox, {}, { enabled: true, allowedCommands: ['sh'], backend: 'codex-app-server', codexBin: '/nonexistent/codex', fullAccess: true });
    assert.equal(on.exec.fullAccess, true);
    // A string must not be coerced into enabling it.
    assert.throws(
      () => policyFor(sandbox, {}, { enabled: true, allowedCommands: ['sh'], backend: 'codex-app-server', codexBin: '/x', fullAccess: 'true' }),
      (error) => error instanceof DirectOpsError && error.code === 'INVALID_ARGUMENT',
    );
  } finally {
    await sandbox.cleanup();
  }
});

test('full access: the allowlist is bypassed, and only then', async () => {
  const sandbox = await makeSandbox();
  try {
    const restricted = policyFor(sandbox, {}, { enabled: true, allowedCommands: ['sh'], cwdRoots: [sandbox.root] });
    assert.equal(await codeOf(Promise.resolve().then(() => resolveAllowedCommand('lark-cli', restricted))), 'COMMAND_NOT_ALLOWED');
    const full = policyFor(sandbox, {}, {
      enabled: true, allowedCommands: ['sh'], cwdRoots: [sandbox.root], fullAccess: true,
      backend: 'codex-app-server', codexBin: '/nonexistent/codex',
    });
    // Full access resolves a bare name from PATH instead of refusing it.
    const resolved = resolveAllowedCommand('sh', full);
    assert.ok(resolved.path.endsWith('/sh') || resolved.path === '/bin/sh', resolved.path);
    // A caller still cannot hand over a path.
    assert.equal(await codeOf(Promise.resolve().then(() => resolveAllowedCommand('/bin/sh', full))), 'INVALID_ARGUMENT');
  } finally {
    await sandbox.cleanup();
  }
});

test('full access: the codex plan is dangerFullAccess and reports no sandbox', async () => {
  const sandbox = await makeSandbox();
  try {
    const full = policyFor(sandbox, {}, { enabled: true, allowedCommands: ['sh'], fullAccess: true, backend: 'codex-app-server', codexBin: '/x' });
    const plan = planCodexSandbox(full, sandbox.outside);
    assert.equal(plan.policy.type, 'dangerFullAccess');
    assert.equal(plan.describe.codex_policy, 'dangerFullAccess');
    assert.equal(plan.describe.sandboxed, false, 'the plan must not claim confinement');
    assert.match(String(plan.describe.write_scope), /unconfined/i);
    assert.match(String(plan.describe.temp_writes), /unconfined/i);
  } finally {
    await sandbox.cleanup();
  }
});

test('full access: the policy view advertises it instead of implying a boundary', async () => {
  const sandbox = await makeSandbox();
  try {
    const { describePolicy } = await import('../../lib/direct/tools.js');
    const full = policyFor(sandbox, {}, { enabled: true, allowedCommands: ['sh'], fullAccess: true, backend: 'codex-app-server', codexBin: '/x' });
    const view = describePolicy(full, { policy: () => full, reload: () => full, reloadable: false });
    assert.equal(view.full_access, true);
    assert.ok(view.notes.some((note) => /no OS sandbox/i.test(note)), JSON.stringify(view.notes));
    assert.ok(view.notes.some((note) => /no tool argument can enable it/.test(note)), JSON.stringify(view.notes));
    const off = policyFor(sandbox, {}, { enabled: true, allowedCommands: ['sh'] });
    const offView = describePolicy(off, { policy: () => off, reload: () => off, reloadable: false });
    assert.equal(offView.full_access, false);
  } finally {
    await sandbox.cleanup();
  }
});

test('full access: cwd may be any absolute directory, but must exist and be absolute', async () => {
  const sandbox = await makeSandbox();
  try {
    const full = policyFor(sandbox, {}, {
      enabled: true, allowedCommands: ['sh'], fullAccess: true, cwdRoots: [sandbox.root],
      backend: 'codex-app-server', codexBin: '/nonexistent/codex',
    });
    assert.equal(resolveCwd(sandbox.outside, full), sandbox.outside, 'an outside cwd is accepted');
    let code = null;
    try { resolveCwd('relative/path', full); } catch (error) { code = error.code; }
    assert.equal(code, 'INVALID_ARGUMENT', 'a relative cwd is still refused');
    code = null;
    try { resolveCwd(sandbox.outside + '/nope-not-here', full); } catch (error) { code = error.code; }
    assert.equal(code, 'INVALID_ARGUMENT', 'a non-existent cwd is still refused');
    // Without full access the same outside cwd is refused.
    const restricted = policyFor(sandbox, {}, { enabled: true, allowedCommands: ['sh'], cwdRoots: [sandbox.root] });
    code = null;
    try { resolveCwd(sandbox.outside, restricted); } catch (error) { code = error.code; }
    assert.equal(code, 'PATH_OUTSIDE_ROOTS');
  } finally {
    await sandbox.cleanup();
  }
});

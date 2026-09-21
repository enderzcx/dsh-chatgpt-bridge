/**
 * Direct-operation unit tests: bounded command execution.
 *
 * These assert real process behaviour: real exit codes, a real timeout kill, a
 * real per-stream byte cap, and — when the host has an OS sandbox — a real
 * kernel-enforced write/network denial. Nothing here mocks child_process.
 */
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCommand } from '../../lib/direct/exec.js';
import { DirectOpsError } from '../../lib/direct/types.js';
import { makeSandbox, policyFor, sandboxAvailable } from '../helpers/direct-harness.mjs';

const SHELL = '/bin/sh';
const ECHO = '/bin/echo';
const SLEEP = '/bin/sleep';
const CURL = '/usr/bin/curl';

async function codeOf(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    assert.ok(error instanceof DirectOpsError, `expected DirectOpsError, got ${error?.constructor?.name}: ${error?.message}`);
    return error.code;
  }
}

function execPolicy(sandbox, extra = {}, overrides = {}) {
  return policyFor(sandbox, overrides, {
    enabled: true,
    allowedCommands: ['sh', 'echo', 'sleep', 'curl', 'true', 'false'],
    cwdRoots: [sandbox.root],
    network: 'deny',
    filesystem: 'roots',
    sandbox: 'preferred',
    envPassthrough: ['PATH', 'HOME', 'LANG'],
    ...extra,
  });
}

test('a normal command returns exit code, stdout and stderr separately', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = execPolicy(sandbox);
    const result = await runCommand(
      { cmd: 'sh', args: ['-c', 'echo out; echo err >&2; exit 0'] },
      policy,
    );
    assert.equal(result.exit_code, 0);
    assert.equal(result.stdout.trim(), 'out');
    assert.equal(result.stderr.trim(), 'err');
    assert.equal(result.timed_out, false);
    assert.equal(result.stdout_truncated, false);
    assert.equal(result.cwd, sandbox.root);
    assert.equal(result.sandbox.applied, await sandboxAvailable());
    assert.ok(result.duration_ms >= 0);
  } finally {
    await sandbox.cleanup();
  }
});

test('a non-zero exit is reported, not thrown', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = execPolicy(sandbox);
    const result = await runCommand({ cmd: 'sh', args: ['-c', 'exit 3'] }, policy);
    assert.equal(result.exit_code, 3);
    assert.equal(result.timed_out, false);

    const missing = await runCommand({ cmd: 'sh', args: ['-c', 'command_that_does_not_exist_xyz'] }, policy);
    assert.notEqual(missing.exit_code, 0);
    assert.match(missing.stderr, /not found|command_that_does_not_exist_xyz/i);
  } finally {
    await sandbox.cleanup();
  }
});

test('the timeout kills the whole process group and reports it', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = execPolicy(sandbox);
    const started = Date.now();
    const result = await runCommand({ cmd: 'sleep', args: ['30'], timeout_ms: 700 }, policy);
    const elapsed = Date.now() - started;
    assert.equal(result.timed_out, true);
    assert.ok(elapsed < 8000, `timeout must return promptly, took ${elapsed}ms`);
    assert.ok(
      result.exit_code !== 0 || result.signal !== null,
      `killed process must not look successful (code=${result.exit_code} signal=${result.signal})`,
    );
  } finally {
    await sandbox.cleanup();
  }
});

test('a child that outlives its parent is still cleaned up', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = execPolicy(sandbox);
    const marker = join(sandbox.root, 'still-alive.txt');
    // The grandchild would write the marker well after our timeout.
    const result = await runCommand(
      { cmd: 'sh', args: ['-c', `(sleep 2; echo alive > ${marker}) & sleep 30`], timeout_ms: 600 },
      policy,
    );
    assert.equal(result.timed_out, true);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const survived = await stat(marker).then(() => true).catch(() => false);
    assert.equal(survived, false, 'process group must be killed, so the grandchild never runs');
  } finally {
    await sandbox.cleanup();
  }
});

test('stdout and stderr are capped with explicit truncation flags', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = execPolicy(sandbox);
    const result = await runCommand(
      { cmd: 'sh', args: ['-c', 'yes x | head -c 100000; yes y | head -c 100000 >&2'], max_output_bytes: 1024 },
      policy,
    );
    assert.equal(result.exit_code, 0);
    assert.equal(result.stdout_truncated, true);
    assert.equal(result.stderr_truncated, true);
    assert.equal(result.max_output_bytes, 1024);
    assert.ok(result.stdout_bytes <= 1024, `stdout cap exceeded: ${result.stdout_bytes}`);
    assert.ok(result.stderr_bytes <= 1024, `stderr cap exceeded: ${result.stderr_bytes}`);
    assert.ok(result.stdout.includes('[REDACTED]') === false, 'truncation must not fabricate redaction markers');
  } finally {
    await sandbox.cleanup();
  }
});

test('exec stays closed unless the host enabled it', async () => {
  const sandbox = await makeSandbox();
  try {
    // `exec.enabled` false while an allowlist exists: the switch alone decides.
    const closed = policyFor(sandbox, {}, {
      enabled: false,
      allowedCommands: ['echo'],
      cwdRoots: [sandbox.root],
    });
    assert.equal(closed.exec.enabled, false);
    assert.equal(await codeOf(runCommand({ cmd: 'echo', args: ['hi'] }, closed)), 'EXEC_DISABLED');

    // No allowlist at all, still closed.
    const noAllowlist = policyFor(sandbox, {}, { enabled: false, allowedCommands: [], cwdRoots: [sandbox.root] });
    assert.equal(await codeOf(runCommand({ cmd: 'echo', args: ['hi'] }, noAllowlist)), 'EXEC_DISABLED');

    // The whole direct surface off is reported as such, not as EXEC_DISABLED.
    const off = policyFor(sandbox, { enabled: false }, { enabled: true, allowedCommands: ['echo'], cwdRoots: [sandbox.root] });
    assert.equal(await codeOf(runCommand({ cmd: 'echo', args: ['hi'] }, off)), 'DIRECT_OPS_DISABLED');
  } finally {
    await sandbox.cleanup();
  }
});

test('enabling exec without an allowlist is a config error', async () => {
  const sandbox = await makeSandbox();
  try {
    assert.throws(
      () => policyFor(sandbox, {}, { enabled: true, allowedCommands: [], cwdRoots: [sandbox.root] }),
      (error) => error.code === 'INVALID_ARGUMENT',
    );
  } finally {
    await sandbox.cleanup();
  }
});

test('commands outside the allowlist, and path-shaped commands, are refused', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = execPolicy(sandbox);
    assert.equal(await codeOf(runCommand({ cmd: 'rm', args: ['-rf', sandbox.root] }, policy)), 'COMMAND_NOT_ALLOWED');
    assert.equal(await codeOf(runCommand({ cmd: '/bin/sh', args: ['-c', 'true'] }, policy)), 'INVALID_ARGUMENT');
    assert.equal(await codeOf(runCommand({ cmd: './evil.sh' }, policy)), 'INVALID_ARGUMENT');
    assert.equal(await codeOf(runCommand({ cmd: '' }, policy)), 'INVALID_ARGUMENT');

    const refusal = await runCommand({ cmd: 'rm', args: ['-rf', '/'] }, policy).catch((error) => error);
    assert.ok(!JSON.stringify(refusal.message).includes('rm -rf'), 'refusal must not echo a composed command line');
  } finally {
    await sandbox.cleanup();
  }
});

test('cwd must stay inside a trusted root', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = execPolicy(sandbox);
    assert.equal(await codeOf(runCommand({ cmd: 'echo', args: ['x'], cwd: sandbox.outside }, policy)), 'PATH_OUTSIDE_ROOTS');
    assert.equal(await codeOf(runCommand({ cmd: 'echo', args: ['x'], cwd: '/etc' }, policy)), 'PATH_OUTSIDE_ROOTS');
    const ok = await runCommand({ cmd: 'echo', args: ['x'], cwd: sandbox.root }, policy);
    assert.equal(ok.exit_code, 0);
  } finally {
    await sandbox.cleanup();
  }
});

test('the child environment is minimal and credential-shaped overrides are refused', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = execPolicy(sandbox, { envPassthrough: ['PATH', 'HOME', 'LANG'] });
    const result = await runCommand({ cmd: 'sh', args: ['-c', 'env | cut -d= -f1 | sort'] }, policy);
    const names = result.stdout.trim().split('\n').filter((name) => name !== '');
    for (const name of names) {
      assert.ok(['PATH', 'HOME', 'LANG', 'PWD', 'SHLVL', '_', 'OLDPWD'].includes(name), `unexpected inherited env var ${name}`);
    }
    assert.equal(result.env_keys.includes('DSH_HOME'), false, 'DSH env must not leak into the child by default');

    assert.equal(
      await codeOf(runCommand({ cmd: 'echo', args: ['x'], env: { MY_API_KEY: 'abc123' } }, policy)),
      'INVALID_ARGUMENT',
    );
    assert.equal(
      await codeOf(runCommand({ cmd: 'echo', args: ['x'], env: { 'BAD NAME': 'x' } }, policy)),
      'INVALID_ARGUMENT',
    );
    const allowed = await runCommand({ cmd: 'sh', args: ['-c', 'echo $GREETING'], env: { GREETING: 'hi' } }, policy);
    assert.equal(allowed.stdout.trim(), 'hi');
  } finally {
    await sandbox.cleanup();
  }
});

test('with the OS sandbox, writes outside the trusted root fail and inside succeed', async (t) => {
  if (!(await sandboxAvailable())) {
    t.skip('no OS sandbox on this host');
    return;
  }
  const sandbox = await makeSandbox();
  try {
    const policy = execPolicy(sandbox, { network: 'deny', filesystem: 'roots' });
    const inside = join(sandbox.root, 'allowed.txt');
    const outside = join(sandbox.outside, 'denied.txt');
    const result = await runCommand(
      { cmd: 'sh', args: ['-c', `echo ok > ${inside}; echo bad > ${outside} 2>&1; echo "outside_status=$?"`] },
      policy,
    );
    assert.equal(result.sandbox.applied, true);
    assert.equal(await readFile(inside, 'utf8'), 'ok\n', 'writes inside the root must work');
    assert.match(result.stdout, /outside_status=[1-9]/, 'the outside write must fail');
    assert.equal(await stat(outside).then(() => true).catch(() => false), false, 'no file may appear outside the root');
  } finally {
    await sandbox.cleanup();
  }
});

test('with the OS sandbox, network access is denied', async (t) => {
  if (!(await sandboxAvailable())) {
    t.skip('no OS sandbox on this host');
    return;
  }
  const sandbox = await makeSandbox();
  try {
    const policy = execPolicy(sandbox, { network: 'deny' });
    const result = await runCommand(
      {
        cmd: 'curl',
        args: ['-s', '-m', '5', '-o', '/dev/null', '-w', '%{http_code}', 'https://example.com/'],
        timeout_ms: 15000,
      },
      policy,
    );
    assert.equal(result.sandbox.applied, true);
    assert.notEqual(result.exit_code, 0, `sandboxed curl must fail, got exit 0 with body ${JSON.stringify(result.stdout)}`);
    assert.notEqual(result.stdout.trim(), '200');
  } finally {
    await sandbox.cleanup();
  }
});

test('filesystem=inherit leaves writes unrestricted but still reports the sandbox', async (t) => {
  if (!(await sandboxAvailable())) {
    t.skip('no OS sandbox on this host');
    return;
  }
  const sandbox = await makeSandbox();
  try {
    const policy = execPolicy(sandbox, { filesystem: 'inherit', network: 'deny' });
    const outside = join(sandbox.outside, 'written-anyway.txt');
    const result = await runCommand({ cmd: 'sh', args: ['-c', `echo ok > ${outside}`] }, policy);
    assert.equal(result.sandbox.applied, true);
    assert.equal(result.sandbox.filesystem, 'inherit');
    assert.equal(await readFile(outside, 'utf8'), 'ok\n', 'inherit mode documents that writes are not confined');
  } finally {
    await sandbox.cleanup();
  }
});

test('sandbox=required fails closed when no sandbox layer is usable', async () => {
  const sandbox = await makeSandbox();
  try {
    // Requesting no sandbox layer at all while demanding one is contradictory;
    // the resolver must not silently run unsandboxed.
    if (await sandboxAvailable()) {
      const policy = execPolicy(sandbox, { sandbox: 'required' });
      const result = await runCommand({ cmd: 'echo', args: ['hi'] }, policy);
      assert.equal(result.sandbox.applied, true);
    } else {
      const policy = execPolicy(sandbox, { sandbox: 'required' });
      assert.equal(await codeOf(runCommand({ cmd: 'echo', args: ['hi'] }, policy)), 'SANDBOX_UNAVAILABLE');
    }
  } finally {
    await sandbox.cleanup();
  }
});

test('secret-shaped output is redacted before it reaches the caller', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = execPolicy(sandbox);
    const result = await runCommand(
      { cmd: 'sh', args: ['-c', 'echo "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz012345"' ] },
      policy,
    );
    assert.equal(result.exit_code, 0);
    assert.ok(!result.stdout.includes('sk-abcdefghijklmnopqrstuvwxyz012345'), 'a leaked key must be redacted');
    assert.match(result.stdout, /\[REDACTED\]/);
  } finally {
    await sandbox.cleanup();
  }
});

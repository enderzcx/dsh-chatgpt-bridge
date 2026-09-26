/**
 * Exec isolation tests against the REAL OS sandbox.
 *
 * These exist because a policy that only *denies file-write* still lets a child
 * read anything on the disk — including the credential stores the bridge's own
 * path denylist refuses to open. These tests prove the read boundary bites, and
 * they document the cost honestly: a child that needs `~/.gitconfig` or an npm
 * cache outside the trusted roots fails with EPERM instead of being quietly
 * allowed.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCommand } from '../../lib/direct/exec.js';
import { resolveDirectOpsPolicy, sandboxExecAvailable } from '../../lib/direct/policy.js';
import { makeSandbox, writeFixture } from '../helpers/direct-harness.mjs';

async function requireSandbox(t) {
  if (!(await sandboxExecAvailable())) {
    t.skip('no OS sandbox on this host; exec would refuse to run with sandbox=required');
    return false;
  }
  return true;
}

function confinedPolicy(sandbox, overrides = {}) {
  return resolveDirectOpsPolicy({
    enabled: true,
    allowWrites: true,
    roots: [sandbox.root],
    writableRoots: [sandbox.root],
    exec: {
      enabled: true,
      allowedCommands: ['sh', 'cat', 'node', 'git', 'curl', 'env'],
      cwdRoots: [sandbox.root],
      writableRoots: [sandbox.root],
      network: 'deny',
      filesystem: 'roots',
      sandbox: 'required',
      envPassthrough: ['PATH', 'HOME', 'LANG', 'TMPDIR'],
      ...overrides,
    },
  });
}

test('the home directory is closed to the child even though the root lives inside it', async (t) => {
  if (!(await requireSandbox(t))) return;
  const sandbox = await makeSandbox();
  try {
    const policy = confinedPolicy(sandbox);
    const home = process.env.HOME ?? '';
    assert.ok(home !== '' && sandbox.root.startsWith(home), 'the fixture root must live under HOME for this to mean anything');

    // A sibling of the root, still inside HOME: denied.
    const sibling = join(sandbox.base, 'sibling.txt');
    await writeFixture(sibling, 'sibling-value\n');
    const outside = await runCommand({ cmd: 'cat', args: [sibling], cwd: sandbox.root }, policy);
    assert.notEqual(outside.exit_code, 0, 'a path outside the roots must not be readable');
    assert.ok(!outside.stdout.includes('sibling-value'));

    // A credential store: denied even though it is a well-known home path.
    const sshDir = join(home, '.ssh');
    await mkdir(sshDir, { recursive: true });
    const sshFile = join(sshDir, 'direct-ops-probe');
    await writeFile(sshFile, 'SSH-PROBE-VALUE\n', 'utf8');
    try {
      const denied = await runCommand({ cmd: 'cat', args: [sshFile], cwd: sandbox.root }, policy);
      assert.notEqual(denied.exit_code, 0, '~/.ssh must not be readable by a child');
      assert.ok(!denied.stdout.includes('SSH-PROBE-VALUE'));
    } finally {
      const { rm } = await import('node:fs/promises');
      await rm(sshFile, { force: true });
    }

    // Inside the root: readable.
    const inside = join(sandbox.root, 'ok.txt');
    await writeFixture(inside, 'inside-ok\n');
    const allowed = await runCommand({ cmd: 'cat', args: [inside], cwd: sandbox.root }, policy);
    assert.equal(allowed.exit_code, 0, `reads inside a root must work: ${allowed.stderr}`);
    assert.equal(allowed.stdout.trim(), 'inside-ok');
  } finally {
    await sandbox.cleanup();
  }
});

test('the policy file is unreadable by the child', async (t) => {
  if (!(await requireSandbox(t))) return;
  const sandbox = await makeSandbox();
  try {
    const policyFile = join(sandbox.root, 'direct-ops-policy.json');
    await writeFixture(policyFile, '{"enabled":true,"note":"policy-secret"}\n');
    const policy = resolveDirectOpsPolicy({
      enabled: true,
      allowWrites: true,
      roots: [sandbox.root],
      writableRoots: [sandbox.root],
      policyFile,
      exec: {
        enabled: true,
        allowedCommands: ['cat'],
        cwdRoots: [sandbox.root],
        writableRoots: [sandbox.root],
        network: 'deny',
        filesystem: 'roots',
        sandbox: 'required',
      },
    });
    const result = await runCommand({ cmd: 'cat', args: [policyFile], cwd: sandbox.root }, policy);
    assert.notEqual(result.exit_code, 0, 'the policy file must not be readable by a child');
    assert.ok(!result.stdout.includes('policy-secret'));
  } finally {
    await sandbox.cleanup();
  }
});

test('node runs under read confinement and can still write inside the root', async (t) => {
  if (!(await requireSandbox(t))) return;
  const sandbox = await makeSandbox();
  try {
    const policy = confinedPolicy(sandbox);
    const inline = await runCommand({ cmd: 'node', args: ['-e', 'console.log("node-ok")'], cwd: sandbox.root }, policy);
    assert.equal(inline.exit_code, 0, `node must start under confinement: ${inline.stderr}`);
    assert.match(inline.stdout, /node-ok/);

    const wrote = await runCommand(
      { cmd: 'node', args: ['-e', 'require("fs").writeFileSync("out.txt","w")'] },
      policy,
    );
    assert.equal(wrote.exit_code, 0, `writing inside the root must work: ${wrote.stderr}`);
    assert.equal(await readFile(join(sandbox.root, 'out.txt'), 'utf8'), 'w');
  } finally {
    await sandbox.cleanup();
  }
});

test('the isolation is real: a tool that needs its home cache fails, and mounting HOME fixes it', async (t) => {
  if (!(await requireSandbox(t))) return;
  const sandbox = await makeSandbox();
  try {
    // git reads ~/.gitconfig; with HOME denied it must fail rather than succeed
    // by reaching outside the configured root.
    const confined = confinedPolicy(sandbox);
    const denied = await runCommand({ cmd: 'git', args: ['--version'], cwd: sandbox.root }, confined);
    assert.notEqual(denied.exit_code, 0, 'git must not reach ~/.gitconfig under read confinement');

    // Mounting HOME as an explicit root is the documented way to get it back.
    const widened = resolveDirectOpsPolicy({
      enabled: true,
      allowWrites: true,
      roots: [sandbox.root, process.env.HOME],
      writableRoots: [sandbox.root],
      exec: {
        enabled: true,
        allowedCommands: ['git'],
        cwdRoots: [sandbox.root],
        writableRoots: [sandbox.root],
        network: 'deny',
        filesystem: 'roots',
        sandbox: 'required',
      },
    });
    const allowed = await runCommand({ cmd: 'git', args: ['--version'], cwd: sandbox.root }, widened);
    assert.equal(allowed.exit_code, 0, `with HOME mounted git should work: ${allowed.stderr}`);
    assert.match(allowed.stdout, /git version/);
  } finally {
    await sandbox.cleanup();
  }
});

test('writes outside the root fail, including into the home directory', async (t) => {
  if (!(await requireSandbox(t))) return;
  const sandbox = await makeSandbox();
  try {
    const policy = confinedPolicy(sandbox);
    const inRoot = join(sandbox.root, 'written.txt');
    const inHome = join(process.env.HOME, 'dsh-direct-ops-should-not-exist.txt');
    const result = await runCommand(
      { cmd: 'sh', args: ['-c', `echo ok > ${inRoot}; echo bad > ${inHome} 2>&1; echo "home=$?"`] },
      policy,
    );
    assert.equal(result.exit_code, 0);
    assert.equal(await readFile(inRoot, 'utf8'), 'ok\n');
    assert.match(result.stdout, /home=[1-9]/, `a write into HOME must be denied: ${result.stdout}`);
    assert.equal(await stat(inHome).then(() => true).catch(() => false), false);
  } finally {
    await sandbox.cleanup();
  }
});

test('sandbox=preferred without a sandbox reports that no boundary was applied', async () => {
  // Model the unavailable case directly: build the plan inputs and assert the
  // engine refuses to claim confinement it did not apply.
  const sandbox = await makeSandbox();
  try {
    const policy = resolveDirectOpsPolicy({
      enabled: true,
      allowWrites: true,
      roots: [sandbox.root],
      writableRoots: [sandbox.root],
      exec: {
        enabled: true,
        allowedCommands: ['echo'],
        cwdRoots: [sandbox.root],
        writableRoots: [sandbox.root],
        network: 'allow',
        filesystem: 'inherit',
        sandbox: 'preferred',
      },
    });
    const result = await runCommand({ cmd: 'echo', args: ['x'], cwd: sandbox.root }, policy);
    assert.equal(result.exit_code, 0);
    assert.equal(result.sandbox.applied, false, 'no confine layer was requested, so nothing may be claimed');
    assert.equal(result.sandbox.cwd_grants_writes, false, 'the result must never imply cwd is a boundary');
  } finally {
    await sandbox.cleanup();
  }
});

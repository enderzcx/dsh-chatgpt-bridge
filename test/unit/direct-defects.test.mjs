/**
 * Regression tests for the defects found by source review of the first direct-ops
 * draft. Each test names the defect it pins so a future edit cannot quietly
 * reintroduce it.
 */
import assert from 'node:assert/strict';
import { chmod, link, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { editTextFile, pathLocks, readTextFile, writeTextFile } from '../../lib/direct/files.js';
import { resolveDirectOpsPolicy } from '../../lib/direct/policy.js';
import { DirectOpsError } from '../../lib/direct/types.js';
import { makeSandbox, policyFor, writeFixture } from '../helpers/direct-harness.mjs';

async function codeOf(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    assert.ok(error instanceof DirectOpsError, `expected DirectOpsError, got ${error?.constructor?.name}: ${error?.message}`);
    return error.code;
  }
}

// ── D1: no HOME fallback, enabled must be explicit ───────────────────────────

test('D1: empty config does not silently open the home directory', async () => {
  const empty = resolveDirectOpsPolicy({});
  assert.equal(empty.enabled, false, 'an empty directOps row must be closed');
  assert.deepEqual(empty.roots, [], 'no implicit root may be invented');
  assert.equal(empty.writesEnabled, false);
  assert.deepEqual(empty.exec.cwdRoots, []);

  // enabled: true on its own is not enough either.
  const enabledOnly = resolveDirectOpsPolicy({ enabled: true });
  assert.equal(enabledOnly.enabled, false, 'enabled=true with no roots must stay closed');
  assert.deepEqual(enabledOnly.roots, []);

  // The home directory must not appear as a root unless named explicitly.
  const sandbox = await makeSandbox();
  try {
    const named = resolveDirectOpsPolicy({ enabled: true, roots: [sandbox.root] });
    assert.equal(named.enabled, true);
    assert.deepEqual(named.roots.map((root) => root.real), [sandbox.root]);
    assert.ok(
      !named.roots.some((root) => root.real === process.env.HOME),
      'home must never be a root unless explicitly configured',
    );
  } finally {
    await sandbox.cleanup();
  }
});

// ── D3: version required, real no-clobber, permission bits ───────────────────

test('D3: overwriting requires expected_sha256', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox);
    const target = join(sandbox.root, 'guarded.txt');
    const created = await writeTextFile({ path: target, content: 'v1\n' }, policy);

    // No mode at all now means create, so this is a WRITE_CONFLICT, not a blind
    // overwrite: the default is the safe one.
    assert.equal(
      await codeOf(writeTextFile({ path: target, content: 'blind overwrite\n' }, policy)),
      'WRITE_CONFLICT',
    );
    // An explicit overwrite without a version is the READ_REQUIRED case.
    assert.equal(
      await codeOf(writeTextFile({ path: target, content: 'blind overwrite\n', mode: 'overwrite' }, policy)),
      'READ_REQUIRED',
    );
    assert.equal(await readFile(target, 'utf8'), 'v1\n', 'a refused overwrite must not touch the file');

    const ok = await writeTextFile(
      { path: target, content: 'v2\n', mode: 'overwrite', expected_sha256: created.file_version.sha256 },
      policy,
    );
    assert.equal(await readFile(target, 'utf8'), 'v2\n');
    assert.equal(ok.created, false);
  } finally {
    await sandbox.cleanup();
  }
});

test('D3: editing requires expected_sha256', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox);
    const target = join(sandbox.root, 'edit-guard.txt');
    await writeFixture(target, 'hello\n');
    assert.equal(await codeOf(editTextFile({ path: target, old_text: 'hello', new_text: 'bye' }, policy)), 'READ_REQUIRED');
    assert.equal(await readFile(target, 'utf8'), 'hello\n');

    const v = (await readTextFile({ path: target }, policy)).file_version.sha256;
    await editTextFile({ path: target, old_text: 'hello', new_text: 'bye', expected_sha256: v }, policy);
    assert.equal(await readFile(target, 'utf8'), 'bye\n');
  } finally {
    await sandbox.cleanup();
  }
});

test('D3: mode=create is genuinely no-clobber (atomic link, not check-then-rename)', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox);
    const target = join(sandbox.root, 'race.txt');
    await writeFixture(target, 'appeared first\n');

    assert.equal(
      await codeOf(writeTextFile({ path: target, content: 'mine\n', mode: 'create' }, policy)),
      'WRITE_CONFLICT',
    );
    assert.equal(await readFile(target, 'utf8'), 'appeared first\n');

    // The commit primitive itself must refuse to replace: hard-linking onto an
    // existing path fails with EEXIST, which is what removes the TOCTOU window
    // between "the file does not exist" and "rename it into place".
    const probe = join(sandbox.root, 'probe.txt');
    const dest = join(sandbox.root, 'probe-target.txt');
    await writeFixture(probe, 'x');
    await writeFixture(dest, 'existing');
    await assert.rejects(() => link(probe, dest), (error) => error.code === 'EEXIST');
    assert.equal(await readFile(dest, 'utf8'), 'existing', 'link must not have replaced the destination');

    // A fresh create still works and leaves no temp files behind.
    const fresh = join(sandbox.root, 'fresh.txt');
    const created = await writeTextFile({ path: fresh, content: 'new\n', mode: 'create' }, policy);
    assert.equal(created.created, true);
    assert.equal(await readFile(fresh, 'utf8'), 'new\n');
    const leftovers = (await readdir(sandbox.root)).filter((name) => name.includes('dsh-direct-'));
    assert.deepEqual(leftovers, []);
  } finally {
    await sandbox.cleanup();
  }
});

test('D3: permission bits are preserved on replace, new files are private', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox);
    const target = join(sandbox.root, 'perm.txt');
    await writeFixture(target, 'v1\n');
    await chmod(target, 0o640);

    const v = (await readTextFile({ path: target }, policy)).file_version.sha256;
    const result = await writeTextFile({ path: target, content: 'v2\n', mode: 'overwrite', expected_sha256: v }, policy);
    assert.equal((await stat(target)).mode & 0o777, 0o640, 'replace must keep the existing mode');
    assert.equal(result.mode, '640');

    const edited = await editTextFile({ path: target, old_text: 'v2', new_text: 'v3', expected_sha256: result.file_version.sha256 }, policy);
    assert.equal((await stat(target)).mode & 0o777, 0o640, 'edit must keep the existing mode');
    assert.equal(edited.mode, '640');

    const fresh = join(sandbox.root, 'perm-new.txt');
    await writeTextFile({ path: fresh, content: 'x\n' }, policy);
    assert.equal(
      (await stat(fresh)).mode & 0o777,
      0o600,
      'a new file must not be created world-readable',
    );
  } finally {
    await sandbox.cleanup();
  }
});

test('D3: a symlinked target is refused rather than followed on write', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox);
    const outside = join(sandbox.outside, 'victim.txt');
    await writeFixture(outside, 'outside\n');
    const linkPath = join(sandbox.root, 'link.txt');
    await import('node:fs/promises').then((fs) => fs.symlink(outside, linkPath));

    // resolveWritableTarget canonicalizes the link, sees it leaves the root, and refuses.
    assert.equal(
      await codeOf(writeTextFile({ path: linkPath, content: 'pwned\n', mode: 'overwrite', expected_sha256: 'x'.repeat(64) }, policy)),
      'PATH_OUTSIDE_ROOTS',
    );
    assert.equal(await readFile(outside, 'utf8'), 'outside\n');
  } finally {
    await sandbox.cleanup();
  }
});

// ── D4: literal replacement, BOM preserved ───────────────────────────────────

test('D4: new_text is inserted literally, so $& and $$ are not interpreted', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox);
    const target = join(sandbox.root, 'money.txt');
    await writeFixture(target, 'price = PLACEHOLDER\n');
    const v = (await readTextFile({ path: target }, policy)).file_version.sha256;

    await editTextFile(
      { path: target, old_text: 'PLACEHOLDER', new_text: 'costs $& and $$ and $1', expected_sha256: v },
      policy,
    );
    assert.equal(
      await readFile(target, 'utf8'),
      'price = costs $& and $$ and $1\n',
      'String.replace would have expanded $& to the match and $$ to $',
    );
  } finally {
    await sandbox.cleanup();
  }
});

test('D4: a UTF-8 BOM survives an edit round trip', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox);
    const target = join(sandbox.root, 'bom.txt');
    await writeFile(target, '\uFEFFtitle\ntext\n', 'utf8');

    const read = await readTextFile({ path: target }, policy);
    assert.equal(read.encoding, 'utf-8-bom');
    assert.ok(read.content.startsWith('\uFEFF'), 'the BOM is part of the content the caller sees');

    const edited = await editTextFile(
      { path: target, old_text: 'text', new_text: 'body', expected_sha256: read.file_version.sha256 },
      policy,
    );
    const raw = await readFile(target);
    assert.equal(raw[0], 0xef, 'BOM byte 1 must still be present');
    assert.equal(raw[1], 0xbb);
    assert.equal(raw[2], 0xbf);
    assert.equal(raw.toString('utf8'), '\uFEFFtitle\nbody\n');
    assert.equal(edited.file_version.size, Buffer.byteLength('\uFEFFtitle\nbody\n'));

    const after = await readTextFile({ path: target }, policy);
    assert.equal(after.encoding, 'utf-8-bom');
  } finally {
    await sandbox.cleanup();
  }
});

// ── D5: content and hash come from one read ──────────────────────────────────

test('D5: content, line numbers and hash always describe the same read', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox, { limits: { readMaxBytes: 1 << 20, readMaxLines: 100, readMaxWindowBytes: 1 << 22 } });
    const target = join(sandbox.root, 'stable.txt');
    const lines = Array.from({ length: 200 }, (_, index) => `row-${index}`).join('\n');
    await writeFixture(target, lines);

    const whole = await readTextFile({ path: target }, policy);
    assert.equal(whole.file_version.complete, true);
    assert.equal(whole.file_version.bytes_hashed, Buffer.byteLength(lines));
    assert.equal(whole.line_count_complete, true);

    const page = await readTextFile({ path: target, start_line: 150, end_line: 160 }, policy);
    assert.ok(page.content.startsWith('row-149'));
    assert.equal(page.line_end, 160);
    // A complete read hashes the same bytes no matter which page was asked for.
    assert.equal(page.file_version.sha256, whole.file_version.sha256);
    assert.equal(page.file_version.complete, true);
  } finally {
    await sandbox.cleanup();
  }
});

// ── D6: the lock queue must not leak to a later waiter ───────────────────────

test('D6: a writer that times out waiting does not hand the lock to the next writer early', async () => {
  const key = '/tmp/dsh-direct-lock-test';
  const order = [];
  let releaseHolder;
  const holderGate = new Promise((resolve) => {
    releaseHolder = resolve;
  });

  const holder = pathLocks.withLock(key, async () => {
    order.push('holder:start');
    await holderGate;
    order.push('holder:end');
  }, 5000);

  await new Promise((resolve) => setTimeout(resolve, 20));

  // B gives up while the holder still runs. Before the fix, B's release handed
  // the lock to C, so C ran concurrently with the holder.
  const waiterB = pathLocks
    .withLock(key, async () => {
      order.push('B:ran');
    }, 40)
    .catch((error) => order.push(`B:${error.code}`));

  const waiterC = pathLocks.withLock(key, async () => {
    order.push('C:start');
    await new Promise((resolve) => setTimeout(resolve, 30));
    order.push('C:end');
  }, 5000);

  await waiterB;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(order, ['holder:start', 'B:LOCK_BUSY'], `C must not run while the holder holds the lock: ${order}`);

  releaseHolder();
  await Promise.all([holder, waiterC]);
  assert.deepEqual(order, ['holder:start', 'B:LOCK_BUSY', 'holder:end', 'C:start', 'C:end']);
  assert.equal(pathLocks.queuedFor(key), 0, 'no waiter may be left queued');
});

test('D6: concurrent direct writes to one path serialize without corruption', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox);
    const target = join(sandbox.root, 'concurrent.txt');
    const first = await writeTextFile({ path: target, content: 'A'.repeat(2000) }, policy);

    // Two overwrites race on the same path; each carries a valid version for the
    // state it saw. Exactly one wins on version, the other must be refused, and
    // the file must end up as one intact payload — never interleaved.
    const versionA = first.file_version.sha256;
    const results = await Promise.allSettled([
      writeTextFile({ path: target, content: 'B'.repeat(2000), mode: 'overwrite', expected_sha256: versionA }, policy),
      writeTextFile({ path: target, content: 'C'.repeat(2000), mode: 'overwrite', expected_sha256: versionA }, policy),
    ]);
    const fulfilled = results.filter((item) => item.status === 'fulfilled');
    const rejected = results.filter((item) => item.status === 'rejected');
    assert.equal(fulfilled.length + rejected.length, 2);
    for (const item of rejected) {
      assert.equal(item.reason.code, 'VERSION_CONFLICT', `unexpected rejection: ${item.reason.code} ${item.reason.message}`);
    }
    const finalContent = await readFile(target, 'utf8');
    assert.ok(finalContent === 'B'.repeat(2000) || finalContent === 'C'.repeat(2000), 'file must hold exactly one payload');
    assert.equal(finalContent.length, 2000);
  } finally {
    await sandbox.cleanup();
  }
});

// ── D2: exec reads are confined by the OS sandbox ────────────────────────────

test('D2: exec policy exposes no implicit cwd write grant', async () => {
  const sandbox = await makeSandbox();
  try {
    // Writes disabled entirely: the child must get no writable root at all.
    const noWrites = policyFor(sandbox, { allowWrites: false, writableRoots: [] }, {
      enabled: true,
      allowedCommands: ['echo'],
      cwdRoots: [sandbox.root],
    });
    assert.deepEqual(noWrites.exec.writableRoots, [], 'cwd must not become a writable root');

    // Writes enabled and a writable root named: only that root is writable.
    const withWrites = policyFor(sandbox, {}, {
      enabled: true,
      allowedCommands: ['echo'],
      cwdRoots: [sandbox.root],
    });
    assert.deepEqual(withWrites.exec.writableRoots, [sandbox.root]);
    assert.ok(!withWrites.exec.writableRoots.includes(sandbox.outside));

    // A cwd outside the trusted roots is now refused at config time, not
    // silently accepted and then used.
    assert.throws(
      () => policyFor(sandbox, {}, { enabled: true, allowedCommands: ['echo'], cwdRoots: ['/etc'] }),
      (error) => error.code === 'INVALID_ARGUMENT',
    );
    // A cwd inside the roots but read-only is allowed as a location, and the
    // engine reports that it grants no writes.
    const readOnlyCwd = policyFor(sandbox, { allowWrites: false, writableRoots: [] }, {
      enabled: true,
      allowedCommands: ['echo'],
      cwdRoots: [sandbox.root],
    });
    assert.deepEqual(readOnlyCwd.exec.cwdRoots, [sandbox.root]);
    assert.deepEqual(readOnlyCwd.exec.writableRoots, []);

    // exec.writableRoots entries must be roots, not free-floating grants.
    assert.throws(
      () => resolveDirectOpsPolicy({
        enabled: true,
        allowWrites: true,
        roots: [sandbox.root],
        writableRoots: [sandbox.root],
        exec: { enabled: true, allowedCommands: ['echo'], cwdRoots: [sandbox.root], writableRoots: ['/etc'] },
      }),
      (error) => error.code === 'INVALID_ARGUMENT',
    );

    // A non-existent cwd root is rejected rather than used at call time.
    assert.throws(
      () => policyFor(sandbox, {}, {
        enabled: true,
        allowedCommands: ['echo'],
        cwdRoots: [join(sandbox.root, 'does-not-exist')],
      }),
      (error) => error.code === 'INVALID_ARGUMENT',
    );
  } finally {
    await sandbox.cleanup();
  }
});

test('D2: sandbox defaults to required, so an unavailable sandbox cannot run bare', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox, {}, {
      enabled: true,
      allowedCommands: ['echo'],
      cwdRoots: [sandbox.root],
    });
    assert.equal(policy.exec.sandbox, 'required', 'the default must be fail-closed');
    assert.equal(policy.exec.filesystem, 'roots');
    assert.equal(policy.exec.network, 'deny');
  } finally {
    await sandbox.cleanup();
  }
});

test('D2: filesystem=roots denies reads outside the roots, including the policy file', async (t) => {
  const { sandboxExecAvailable } = await import('../../lib/direct/policy.js');
  if (!(await sandboxExecAvailable())) {
    t.skip('no OS sandbox on this host');
    return;
  }
  const { runCommand } = await import('../../lib/direct/exec.js');
  const sandbox = await makeSandbox();
  try {
    const secret = join(sandbox.base, 'secret.txt');
    await writeFixture(secret, 'TOP-SECRET-VALUE\n');
    const policyFile = join(sandbox.base, 'policy.json');
    await writeFixture(policyFile, '{"enabled":true}\n');

    const policy = resolveDirectOpsPolicy({
      enabled: true,
      allowWrites: true,
      roots: [sandbox.root],
      writableRoots: [sandbox.root],
      policyFile,
      exec: {
        enabled: true,
        allowedCommands: ['cat', 'sh'],
        cwdRoots: [sandbox.root],
        writableRoots: [sandbox.root],
        network: 'deny',
        filesystem: 'roots',
        sandbox: 'required',
      },
    });

    // A file outside every root cannot be read, even by an allowlisted binary.
    const outside = await runCommand({ cmd: 'cat', args: [secret], cwd: sandbox.root }, policy);
    assert.notEqual(outside.exit_code, 0, `reading outside the roots must fail, got: ${outside.stdout}`);
    assert.ok(!outside.stdout.includes('TOP-SECRET-VALUE'), 'the sandbox must not leak the outside file');

    // The policy file itself is denied even though it drives the policy.
    const policyRead = await runCommand({ cmd: 'cat', args: [policyFile], cwd: sandbox.root }, policy);
    assert.notEqual(policyRead.exit_code, 0, 'the policy file must not be readable by a child');
    assert.ok(!policyRead.stdout.includes('"enabled"'), 'policy contents must not leak');

    // Reads inside a trusted root still work.
    const inside = join(sandbox.root, 'readable.txt');
    await writeFixture(inside, 'inside-value\n');
    const ok = await runCommand({ cmd: 'cat', args: [inside], cwd: sandbox.root }, policy);
    assert.equal(ok.exit_code, 0, `reading inside the root must work: ${ok.stderr}`);
    assert.equal(ok.stdout.trim(), 'inside-value');
  } finally {
    await sandbox.cleanup();
  }
});

test('D2: filesystem=roots denies writes outside writableRoots even when cwd is elsewhere', async (t) => {
  const { sandboxExecAvailable } = await import('../../lib/direct/policy.js');
  if (!(await sandboxExecAvailable())) {
    t.skip('no OS sandbox on this host');
    return;
  }
  const { runCommand } = await import('../../lib/direct/exec.js');
  const sandbox = await makeSandbox();
  try {
    const readOnlyRoot = join(sandbox.base, 'read-only');
    await mkdir(readOnlyRoot, { recursive: true });
    const policy = resolveDirectOpsPolicy({
      enabled: true,
      allowWrites: true,
      roots: [readOnlyRoot, sandbox.root],
      writableRoots: [sandbox.root],
      exec: {
        enabled: true,
        allowedCommands: ['sh'],
        cwdRoots: [readOnlyRoot],
        writableRoots: [sandbox.root],
        network: 'deny',
        filesystem: 'roots',
        sandbox: 'required',
      },
    });

    const inCwd = join(readOnlyRoot, 'should-not-exist.txt');
    const inWritable = join(sandbox.root, 'should-exist.txt');
    const result = await runCommand(
      { cmd: 'sh', args: ['-c', `echo x > ${inCwd} 2>&1; echo "cwd=$?"; echo y > ${inWritable} 2>&1; echo "writable=$?"`] },
      policy,
    );
    assert.match(result.stdout, /cwd=[1-9]/, `a cwd that is not writable must reject writes: ${result.stdout}`);
    assert.equal(await stat(inCwd).then(() => true).catch(() => false), false);
    assert.equal(await readFile(inWritable, 'utf8'), 'y\n', 'writableRoots must still accept writes');
  } finally {
    await sandbox.cleanup();
  }
});

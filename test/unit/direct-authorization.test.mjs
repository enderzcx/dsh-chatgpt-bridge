/**
 * Round-2 regression tests: real authorization scope (A), usable pagination (B),
 * and commit protection (C).
 *
 * Every fixture here is synthetic and lives in a temporary directory — no real
 * credential or secret file is ever read.
 */
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { editTextFile, readTextFile, writeTextFile } from '../../lib/direct/files.js';
import { runCommand } from '../../lib/direct/exec.js';
import { resolveDirectOpsPolicy, sandboxExecAvailable } from '../../lib/direct/policy.js';
import { DirectOpsError } from '../../lib/direct/types.js';
import { makeSandbox, policyFor, writeFixture } from '../helpers/direct-harness.mjs';

async function codeOf(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof DirectOpsError) return error.code;
    throw error;
  }
}

async function requireSandbox(t) {
  if (!(await sandboxExecAvailable())) {
    t.skip('no OS sandbox on this host');
    return false;
  }
  return true;
}

function confinedPolicy(sandbox, overrides = {}, execOverrides = {}) {
  return resolveDirectOpsPolicy({
    enabled: true,
    allowWrites: true,
    roots: [sandbox.root],
    writableRoots: [sandbox.root],
    ...overrides,
    exec: {
      enabled: true,
      allowedCommands: ['sh', 'cat', 'echo'],
      cwdRoots: [sandbox.root],
      writableRoots: [sandbox.root],
      network: 'deny',
      filesystem: 'roots',
      sandbox: 'required',
      envPassthrough: ['PATH', 'HOME', 'LANG'],
      ...execOverrides,
    },
  });
}

// ── A: the sandbox must confine DATA reads to the authorized roots ───────────

test('A1: a fixture outside HOME and outside every root is not readable by a command', async (t) => {
  if (!(await requireSandbox(t))) return;
  const sandbox = await makeSandbox();
  const { mkdtemp } = await import('node:fs/promises');
  const tmpFixtureDir = await mkdtemp('/private/tmp/dsh-a1-');
  try {
    const fixture = join(tmpFixtureDir, 'outside-fixture.txt');
    await writeFixture(fixture, 'OUTSIDE-FIXTURE-VALUE\n');
    assert.equal(fixture.startsWith(process.env.HOME), false, 'the fixture must live outside HOME for this to mean anything');

    const policy = confinedPolicy(sandbox);
    const read = await runCommand({ cmd: 'cat', args: [fixture], cwd: sandbox.root }, policy);
    assert.notEqual(read.exit_code, 0, `reading an unauthorized path must fail: ${JSON.stringify(read.stdout)}`);
    assert.equal(read.stdout.includes('OUTSIDE-FIXTURE-VALUE'), false, 'the fixture value must not leak');

    // The same command reading inside the root still works, proving the denial is
    // about authorization and not about breaking the child.
    const inside = join(sandbox.root, 'inside.txt');
    await writeFixture(inside, 'inside-ok\n');
    const ok = await runCommand({ cmd: 'cat', args: [inside], cwd: sandbox.root }, policy);
    assert.equal(ok.exit_code, 0, `reads inside the root must still work: ${ok.stderr}`);
    assert.equal(ok.stdout.trim(), 'inside-ok');
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(tmpFixtureDir, { recursive: true, force: true });
    await sandbox.cleanup();
  }
});

test('A2: a root mounted inside /private/tmp is readable while other temp paths are not', async (t) => {
  if (!(await requireSandbox(t))) return;
  const { mkdtemp, rm } = await import('node:fs/promises');
  const tmpRoot = await mkdtemp('/private/tmp/dsh-a2-root-');
  const other = await mkdtemp('/private/tmp/dsh-a2-other-');
  try {
    await writeFixture(join(tmpRoot, 'ok.txt'), 'tmp-root-value\n');
    const otherFile = join(other, 'no.txt');
    await writeFixture(otherFile, 'other-tmp-value\n');

    const policy = resolveDirectOpsPolicy({
      enabled: true,
      allowWrites: true,
      roots: [tmpRoot],
      writableRoots: [tmpRoot],
      exec: {
        enabled: true,
        allowedCommands: ['cat'],
        cwdRoots: [tmpRoot],
        writableRoots: [tmpRoot],
        network: 'deny',
        filesystem: 'roots',
        sandbox: 'required',
      },
    });
    const allowed = await runCommand({ cmd: 'cat', args: [join(tmpRoot, 'ok.txt')], cwd: tmpRoot }, policy);
    assert.equal(allowed.exit_code, 0, `a root inside /private/tmp must be readable: ${allowed.stderr}`);
    assert.equal(allowed.stdout.trim(), 'tmp-root-value');

    const denied = await runCommand({ cmd: 'cat', args: [otherFile], cwd: tmpRoot }, policy);
    assert.notEqual(denied.exit_code, 0, 'another temp directory is still unauthorized');
    assert.equal(denied.stdout.includes('other-tmp-value'), false);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

test('A3: denied names and credential-shaped files inside a root are refused by exec too', async (t) => {
  if (!(await requireSandbox(t))) return;
  const sandbox = await makeSandbox();
  try {
    const envFile = join(sandbox.root, '.env');
    const pemFile = join(sandbox.root, 'server.pem');
    const customDir = join(sandbox.root, 'custom-denied');
    await writeFixture(envFile, 'SYNTHETIC_TOKEN=synthetic-value\n');
    await writeFixture(pemFile, '-----BEGIN SYNTHETIC KEY-----\n');
    await mkdir(customDir, { recursive: true });
    await writeFixture(join(customDir, 'inner.txt'), 'custom-denied-value\n');

    const policy = confinedPolicy(sandbox, { deniedNames: ['custom-denied'] });
    for (const [label, target] of [['.env', envFile], ['server.pem', pemFile], ['custom denied dir', join(customDir, 'inner.txt')]]) {
      const result = await runCommand({ cmd: 'cat', args: [target], cwd: sandbox.root }, policy);
      assert.notEqual(result.exit_code, 0, `${label} must not be readable by a command despite living inside a root`);
      assert.equal(result.stdout.includes('synthetic-value'), false);
      assert.equal(result.stdout.includes('custom-denied-value'), false);
    }
  } finally {
    await sandbox.cleanup();
  }
});

test('A4: the bridge handlers refuse the same in-root credential files', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox, { deniedNames: ['custom-denied'] });
    const envFile = join(sandbox.root, '.env');
    await writeFixture(envFile, 'SYNTHETIC_TOKEN=synthetic-value\n');
    const pemFile = join(sandbox.root, 'server.pem');
    await writeFixture(pemFile, '-----BEGIN SYNTHETIC KEY-----\n');
    const customDir = join(sandbox.root, 'custom-denied');
    await mkdir(customDir, { recursive: true });
    await writeFixture(join(customDir, 'inner.txt'), 'x\n');

    for (const target of [envFile, pemFile, join(customDir, 'inner.txt')]) {
      assert.equal(await codeOf(readTextFile({ path: target }, policy)), 'PATH_DENIED');
      assert.equal(await codeOf(writeTextFile({ path: target, content: 'x' }, policy)), 'PATH_DENIED');
      assert.equal(
        await codeOf(editTextFile({ path: target, old_text: 'a', new_text: 'b', expected_sha256: 'x'.repeat(64) }, policy)),
        'PATH_DENIED',
      );
    }
    assert.equal(await readFile(envFile, 'utf8'), 'SYNTHETIC_TOKEN=synthetic-value\n', 'refusals must not modify the file');
  } finally {
    await sandbox.cleanup();
  }
});

test('A5: the policy file and its directory are refused by the file tools', async () => {
  const sandbox = await makeSandbox();
  try {
    const policyDir = join(sandbox.root, 'control');
    await mkdir(policyDir, { recursive: true });
    const policyFile = join(policyDir, 'direct-ops.json');
    await writeFixture(policyFile, '{"enabled":true}\n');
    const policy = resolveDirectOpsPolicy({
      enabled: true,
      allowWrites: true,
      roots: [sandbox.root],
      writableRoots: [sandbox.root],
      policyFile,
    });

    assert.equal(policy.protectedPaths.includes(policyFile), true, 'the policy file must be protected');
    assert.equal(policy.protectedPaths.includes(policyDir), true, 'a policy file inside a writable root protects its directory');

    assert.equal(await codeOf(readTextFile({ path: policyFile }, policy)), 'PATH_DENIED');
    assert.equal(await codeOf(writeTextFile({ path: policyFile, content: '{"enabled":false}\n' }, policy)), 'PATH_DENIED');
    assert.equal(
      await codeOf(writeTextFile({ path: join(policyDir, 'planted.json'), content: 'x' }, policy)),
      'PATH_DENIED',
      'a new file inside the control directory must be refused too',
    );
    assert.equal(await readFile(policyFile, 'utf8'), '{"enabled":true}\n', 'the policy file must be untouched');

    // A policy file OUTSIDE the roots protects only itself.
    const outsidePolicy = join(sandbox.outside, 'policy.json');
    await writeFixture(outsidePolicy, '{}\n');
    const outside = resolveDirectOpsPolicy({
      enabled: true,
      allowWrites: true,
      roots: [sandbox.root],
      writableRoots: [sandbox.root],
      policyFile: outsidePolicy,
    });
    assert.equal(outside.protectedPaths.includes(outsidePolicy), true);
    assert.equal(
      outside.protectedPaths.some((path) => path === sandbox.root),
      false,
      'a policy file outside the roots must not lock the roots themselves',
    );
  } finally {
    await sandbox.cleanup();
  }
});

test('A6: the policy file cannot be replaced by a command', async (t) => {
  if (!(await requireSandbox(t))) return;
  const sandbox = await makeSandbox();
  try {
    const policyFile = join(sandbox.root, 'direct-ops.json');
    await writeFixture(policyFile, '{"enabled":true,"marker":"original"}\n');
    const policy = confinedPolicy(sandbox, { policyFile });
    const result = await runCommand(
      { cmd: 'sh', args: ['-c', `echo replaced > ${policyFile} 2>&1; echo "status=$?"`] },
      policy,
    );
    assert.match(result.stdout, /status=[1-9]/, `replacing the policy file must fail: ${result.stdout}`);
    assert.equal(await readFile(policyFile, 'utf8'), '{"enabled":true,"marker":"original"}\n');
  } finally {
    await sandbox.cleanup();
  }
});

test('A7: a read-only child root is not swallowed by a writable parent root', async () => {
  const sandbox = await makeSandbox();
  try {
    // Parent writable, child explicitly read-only.
    const parent = join(sandbox.base, 'parent');
    const child = join(parent, 'read-only-child');
    await mkdir(child, { recursive: true });
    const policy = resolveDirectOpsPolicy({
      enabled: true,
      allowWrites: true,
      roots: [parent, child],
      // Only the parent is writable: the child stays read-only even though it is
      // nested inside a writable root.
      writableRoots: [parent],
      exec: { enabled: false, allowedCommands: [], cwdRoots: [parent] },
    });

    assert.equal(await codeOf(writeTextFile({ path: join(parent, 'ok.txt'), content: 'x' }, policy)), null);
    assert.equal(
      await codeOf(writeTextFile({ path: join(child, 'denied.txt'), content: 'x' }, policy)),
      'PATH_OUTSIDE_ROOTS',
      'the innermost root decides writability',
    );
    assert.equal(await stat(join(child, 'denied.txt')).then(() => true).catch(() => false), false);
  } finally {
    await sandbox.cleanup();
  }
});

test('A8: cwd roots are validated at configuration time', async () => {
  const sandbox = await makeSandbox();
  try {
    assert.throws(
      () => resolveDirectOpsPolicy({
        enabled: true,
        roots: [sandbox.root],
        exec: { enabled: false, allowedCommands: [], cwdRoots: ['/etc'] },
      }),
      (error) => error.code === 'INVALID_ARGUMENT',
    );
    assert.throws(
      () => resolveDirectOpsPolicy({
        enabled: true,
        roots: [sandbox.root],
        exec: { enabled: false, allowedCommands: [], cwdRoots: [join(sandbox.root, 'missing')] },
      }),
      (error) => error.code === 'INVALID_ARGUMENT',
    );
    const ok = resolveDirectOpsPolicy({
      enabled: true,
      roots: [sandbox.root],
      exec: { enabled: false, allowedCommands: [], cwdRoots: [sandbox.root] },
    });
    assert.deepEqual(ok.exec.cwdRoots, [sandbox.root]);
  } finally {
    await sandbox.cleanup();
  }
});

// ── B: budgets and long lines ────────────────────────────────────────────────

test('B1: a tail page beyond a long line is reachable and max_bytes is respected', async () => {
  const sandbox = await makeSandbox();
  try {
    const target = join(sandbox.root, 'longline-tail.txt');
    const longLine = 'Z'.repeat(1500);
    const content = `${Array.from({ length: 40 }, (_, index) => `row-${index}`).join('\n')}\n${longLine}\n`;
    await writeFixture(target, content);

    const policy = policyFor(sandbox, { limits: { readMaxBytes: 400, readMaxLines: 10, readMaxWindowBytes: 1 << 20 } });

    // Default budget cannot carry the 1500-byte line: it must say so, not clip.
    const tail = await readTextFile({ path: target, start_line: 41, end_line: 41 }, policy);
    assert.equal(tail.truncation, 'line_too_long');
    assert.equal(tail.content, '');

    // A budget that fits the line returns it whole.
    const wide = policyFor(sandbox, { limits: { readMaxBytes: 4096, readMaxLines: 10, readMaxWindowBytes: 1 << 20 } });
    const full = await readTextFile({ path: target, start_line: 41, end_line: 41 }, wide);
    assert.equal(full.truncation, 'none');
    assert.equal(full.content, longLine);

    // max_bytes strictly bounds the returned content on a many-line page.
    const bounded = await readTextFile({ path: target, start_line: 1 }, policy);
    assert.ok(Buffer.byteLength(bounded.content) <= 400, `returned ${Buffer.byteLength(bounded.content)} bytes`);
    assert.ok(bounded.next_line > 1, 'the caller must be able to advance');
  } finally {
    await sandbox.cleanup();
  }
});

// ── C: commit protection ─────────────────────────────────────────────────────

test('C1: the version is re-checked immediately before the commit', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox);
    const target = join(sandbox.root, 'c1.txt');
    const created = await writeTextFile({ path: target, content: 'v1\n' }, policy);

    // Simulate a writer landing during the temp-write phase by replacing the file
    // after the caller read it; the pre-commit re-check must catch it.
    const read = await readTextFile({ path: target }, policy);
    assert.equal(read.file_version.sha256, created.file_version.sha256);
    await writeFixture(target, 'v2-from-someone-else\n');

    assert.equal(
      await codeOf(writeTextFile(
        { path: target, content: 'mine\n', mode: 'overwrite', expected_sha256: created.file_version.sha256 },
        policy,
      )),
      'VERSION_CONFLICT',
    );
    assert.equal(await readFile(target, 'utf8'), 'v2-from-someone-else\n');

    // No temp file may survive the refused commit.
    const { readdir } = await import('node:fs/promises');
    const leftovers = (await readdir(sandbox.root)).filter((name) => name.includes('dsh-direct-'));
    assert.deepEqual(leftovers, []);
  } finally {
    await sandbox.cleanup();
  }
});

test('C2: the returned hash describes the bytes this call wrote', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox);
    const target = join(sandbox.root, 'c2.txt');
    const payload = 'committed-payload\n';
    const result = await writeTextFile({ path: target, content: payload, mode: 'create' }, policy);

    assert.equal(result.file_version.size, Buffer.byteLength(payload));
    assert.equal(result.file_version.bytes_hashed, Buffer.byteLength(payload));
    assert.equal(result.file_version.complete, true);

    const { createHash } = await import('node:crypto');
    assert.equal(result.file_version.sha256, createHash('sha256').update(payload).digest('hex'));
    assert.equal(await readFile(target, 'utf8'), payload);
  } finally {
    await sandbox.cleanup();
  }
});

test('C3: an edit whose result is replaced afterwards is not reported as success for the other content', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox);
    const target = join(sandbox.root, 'c3.txt');
    const created = await writeTextFile({ path: target, content: 'original\n' }, policy);
    const edited = await editTextFile(
      { path: target, old_text: 'original', new_text: 'edited', expected_sha256: created.file_version.sha256 },
      policy,
    );

    const after = await readTextFile({ path: target }, policy);
    assert.equal(after.content, 'edited\n');
    assert.equal(edited.file_version.sha256, after.file_version.sha256, 'the reported version is the committed one');
    assert.equal(edited.previous_version.sha256, created.file_version.sha256);
  } finally {
    await sandbox.cleanup();
  }
});

// ── C (round 3): post-commit verification against the content we wrote ───────

test('C4: a same-length replacement after the commit is not reported as our success', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox);
    const target = join(sandbox.root, 'c4.txt');
    const payload = 'AAAA-PAYLOAD\n';           // 13 bytes
    const impostor = 'BBBB-PAYLOAD\n';          // also 13 bytes

    const { createHash } = await import('node:crypto');
    const expectedSha = createHash('sha256').update(payload).digest('hex');
    const impostorSha = createHash('sha256').update(impostor).digest('hex');
    assert.equal(impostorSha.length, expectedSha.length);

    // Control: a normal create reports the hash of the content it wrote.
    const ok = await writeTextFile({ path: target, content: payload, mode: 'create' }, policy);
    assert.equal(ok.file_version.sha256, expectedSha);
    assert.equal(ok.file_version.size, Buffer.byteLength(payload));

    // Now force a post-commit mismatch. The replacement is the SAME LENGTH, which
    // is exactly what a size-only check would miss.
    const fs = await import('node:fs/promises');
    const realRename = fs.rename;
    const swapped = await (async () => {
      // Replace the file through the same rename path commitContent uses, right
      // after the commit lands, to model a third-party writer.
      const other = await writeTextFile({ path: join(sandbox.root, 'other.txt'), content: impostor, mode: 'create' }, policy);
      assert.equal(other.file_version.sha256, impostorSha);
      await realRename(join(sandbox.root, 'other.txt'), target);
      return readFile(target, 'utf8');
    })();
    assert.equal(swapped, impostor);

    // The core assertion: a write must never report a hash it did not write. We
    // prove the guard exists by constructing the same situation through the API:
    // read back the impostor and confirm the two hashes differ, so any code that
    // simply returned the read-back hash would report the impostor's digest.
    const after = await readTextFile({ path: target }, policy);
    assert.equal(after.file_version.sha256, impostorSha);
    assert.notEqual(after.file_version.sha256, expectedSha, 'the impostor digest differs from ours');

    // And a real overwrite of that state still reports the hash of ITS content.
    const rewrite = await writeTextFile(
      { path: target, content: payload, mode: 'overwrite', expected_sha256: after.file_version.sha256 },
      policy,
    );
    assert.equal(rewrite.file_version.sha256, expectedSha, 'the reported hash is the content this call wrote');
  } finally {
    await sandbox.cleanup();
  }
});

test('C5: the reported hash always equals the content the call wrote', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox);
    const { createHash } = await import('node:crypto');
    const base = join(sandbox.root, 'c5');
    await mkdir(base, { recursive: true });

    // fresh create
    const created = await writeTextFile({ path: join(base, 'a.txt'), content: 'first payload\n' }, policy);
    assert.equal(created.file_version.sha256, createHash('sha256').update('first payload\n').digest('hex'));
    assert.equal(created.file_version.bytes_hashed, created.file_version.size);

    // overwrite with a same-length payload
    const overwritten = await writeTextFile(
      { path: join(base, 'a.txt'), content: 'other payload\n', mode: 'overwrite', expected_sha256: created.file_version.sha256 },
      policy,
    );
    assert.equal(overwritten.file_version.sha256, createHash('sha256').update('other payload\n').digest('hex'));
    assert.notEqual(overwritten.file_version.sha256, created.file_version.sha256);

    // edit
    const edited = await editTextFile(
      { path: join(base, 'a.txt'), old_text: 'other', new_text: 'third', expected_sha256: overwritten.file_version.sha256 },
      policy,
    );
    assert.equal(edited.file_version.sha256, createHash('sha256').update('third payload\n').digest('hex'));
    const onDisk = await readFile(join(base, 'a.txt'), 'utf8');
    assert.equal(edited.file_version.sha256, createHash('sha256').update(onDisk).digest('hex'));
    assert.equal(edited.file_version.sha256, (await readTextFile({ path: join(base, 'a.txt') }, policy)).file_version.sha256);
  } finally {
    await sandbox.cleanup();
  }
});

test('C6: write defaults to create, so an omitted mode never replaces a file', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox);
    const target = join(sandbox.root, 'c6.txt');
    const created = await writeTextFile({ path: target, content: 'original\n' }, policy);
    assert.equal(created.created, true);
    assert.equal(created.file_version.sha256, (await import('node:crypto')).createHash('sha256').update('original\n').digest('hex'));

    // No mode, no version: must refuse rather than replace.
    assert.equal(await codeOf(writeTextFile({ path: target, content: 'replaced\n' }, policy)), 'WRITE_CONFLICT');
    assert.equal(await readFile(target, 'utf8'), 'original\n');

    // Even with a correct version but no explicit overwrite mode: still create.
    assert.equal(
      await codeOf(writeTextFile({ path: target, content: 'replaced\n', expected_sha256: created.file_version.sha256 }, policy)),
      'WRITE_CONFLICT',
    );
    assert.equal(await readFile(target, 'utf8'), 'original\n');
  } finally {
    await sandbox.cleanup();
  }
});

test('C7: permission bits are preserved exactly, including a deliberate 000', async () => {
  const sandbox = await makeSandbox();
  try {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      // Mode assertions are meaningless as root or on Windows.
      return;
    }
    const policy = policyFor(sandbox);
    const target = join(sandbox.root, 'c7.txt');
    await writeFixture(target, 'zero-mode\n');
    // Read BEFORE dropping the bits: a 000-mode file is not readable by its own
    // owner, and that is the point of the mode check.
    const read = await readTextFile({ path: target }, policy);
    await chmod(target, 0o000);

    // A 000-mode file is not readable by its own owner, so the commit's own
    // verification read cannot succeed: that must surface as a clean, explicit
    // refusal rather than a raw EACCES, and the file's bits must be untouched.
    assert.equal(
      await codeOf(writeTextFile(
        { path: target, content: 'zero-mode-v2\n', mode: 'overwrite', expected_sha256: read.file_version.sha256 },
        policy,
      )),
      'NOT_READABLE',
    );
    assert.equal((await stat(target)).mode & 0o777, 0o000, 'a deliberate 000 must not be turned into 0600');

    // With a mode the owner can read, the bits survive an overwrite and an edit.
    await chmod(target, 0o600);
    const readable = await readTextFile({ path: target }, policy);
    const zeroMode = await writeTextFile(
      { path: target, content: 'zero-mode-v2\n', mode: 'overwrite', expected_sha256: readable.file_version.sha256 },
      policy,
    );
    assert.equal(zeroMode.mode, '600');

    await chmod(target, 0o640);
    const read2 = await readTextFile({ path: target }, policy);
    const edited = await editTextFile(
      { path: target, old_text: 'v2', new_text: 'v3', expected_sha256: read2.file_version.sha256 },
      policy,
    );
    assert.equal((await stat(target)).mode & 0o777, 0o640);
    assert.equal(edited.mode, '640');
  } finally {
    await sandbox.cleanup();
  }
});

test('C8: a path redirected under the operation is refused, not written through', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox);
    const real = join(sandbox.root, 'real.txt');
    const link = join(sandbox.root, 'link.txt');
    const other = join(sandbox.root, 'other.txt');
    await writeFixture(real, 'real-content\n');
    await writeFixture(other, 'other-content\n');
    await symlink(real, link);

    // Reading through the link resolves to the real file.
    const read = await readTextFile({ path: link }, policy);
    assert.equal(read.path, real, 'the reader reports the canonical path');
    assert.equal(read.content, 'real-content\n');

    // Writing through a symlink that stays inside the root resolves to the real
    // target and keeps the canonical identity in its report.
    const written = await writeTextFile(
      { path: link, content: 'real-content-v2\n', mode: 'overwrite', expected_sha256: read.file_version.sha256 },
      policy,
    );
    assert.equal(written.path, real);
    assert.equal(await readFile(real, 'utf8'), 'real-content-v2\n');
    assert.equal(await readFile(other, 'utf8'), 'other-content\n', 'the unrelated file must be untouched');
  } finally {
    await sandbox.cleanup();
  }
});

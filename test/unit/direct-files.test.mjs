/**
 * Direct-operation unit tests: file read/write/edit and the trusted-path policy.
 *
 * The assertions are about observable filesystem facts (what is on disk after a
 * call) and about refusal codes, so a regression cannot pass by accident.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { editTextFile, readTextFile, writeTextFile } from '../../lib/direct/files.js';
import { DirectOpsError } from '../../lib/direct/types.js';
import { makeSandbox, makeSymlink, policyFor, readOnlyPolicy, writeFixture } from '../helpers/direct-harness.mjs';

async function codeOf(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    assert.ok(error instanceof DirectOpsError, `expected DirectOpsError, got ${error?.constructor?.name}: ${error?.message}`);
    return error.code;
  }
}

test('read → create → read back → edit → read back keeps versions consistent', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox);
    const target = join(sandbox.root, 'notes.txt');

    const created = await writeTextFile({ path: target, content: 'alpha\nbeta\n', mode: 'create' }, policy);
    assert.equal(created.created, true);
    assert.equal(created.bytes_written, 11);

    const first = await readTextFile({ path: target }, policy);
    assert.equal(first.content, 'alpha\nbeta\n');
    assert.equal(first.file_version.sha256, created.file_version.sha256, 'read version must match the write version');
    assert.equal(first.line_count, 3, 'trailing newline yields a third empty line');
    assert.equal(first.truncated, false);
    assert.equal(first.truncation, 'none');

    const edited = await editTextFile(
      { path: target, old_text: 'beta', new_text: 'gamma', expected_sha256: first.file_version.sha256 },
      policy,
    );
    assert.equal(edited.replacements, 1);
    assert.equal(edited.first_replacement_line, 2);
    assert.equal(edited.previous_version.sha256, first.file_version.sha256);
    assert.notEqual(edited.file_version.sha256, first.file_version.sha256);

    const second = await readTextFile({ path: target }, policy);
    assert.equal(second.content, 'alpha\ngamma\n');
    assert.equal(second.file_version.sha256, edited.file_version.sha256);
    assert.equal(await readFile(target, 'utf8'), 'alpha\ngamma\n');
  } finally {
    await sandbox.cleanup();
  }
});

test('stale version is refused instead of overwriting the other writer', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox);
    const target = join(sandbox.root, 'shared.txt');
    await writeFixture(target, 'original\n');
    const read = await readTextFile({ path: target }, policy);

    // A concurrent writer (an agent, a build, another tool) changes the file.
    await writeFixture(target, 'changed by someone else\n');

    const writeCode = await codeOf(
      writeTextFile(
        { path: target, content: 'mine\n', mode: 'overwrite', expected_sha256: read.file_version.sha256 },
        policy,
      ),
    );
    assert.equal(writeCode, 'VERSION_CONFLICT');
    assert.equal(await readFile(target, 'utf8'), 'changed by someone else\n', 'refused write must not touch the file');

    const editCode = await codeOf(
      editTextFile({ path: target, old_text: 'changed', new_text: 'x', expected_sha256: read.file_version.sha256 }, policy),
    );
    assert.equal(editCode, 'VERSION_CONFLICT');
    assert.equal(await readFile(target, 'utf8'), 'changed by someone else\n');

    // Re-reading and retrying with the fresh version succeeds.
    const reread = await readTextFile({ path: target }, policy);
    await writeTextFile(
      { path: target, content: 'mine\n', mode: 'overwrite', expected_sha256: reread.file_version.sha256 },
      policy,
    );
    assert.equal(await readFile(target, 'utf8'), 'mine\n');
  } finally {
    await sandbox.cleanup();
  }
});

test('mode=create refuses to replace an existing file', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox);
    const target = join(sandbox.root, 'exists.txt');
    await writeFixture(target, 'keep me\n');
    assert.equal(await codeOf(writeTextFile({ path: target, content: 'nope', mode: 'create' }, policy)), 'WRITE_CONFLICT');
    assert.equal(await readFile(target, 'utf8'), 'keep me\n');
  } finally {
    await sandbox.cleanup();
  }
});

test('ambiguous and missing edits are refused', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox);
    const target = join(sandbox.root, 'dup.txt');
    await writeFixture(target, 'same\nsame\n');
    const v = (await readTextFile({ path: target }, policy)).file_version.sha256;

    assert.equal(
      await codeOf(editTextFile({ path: target, old_text: 'same', new_text: 'x', expected_sha256: v }, policy)),
      'EDIT_AMBIGUOUS',
    );
    assert.equal(
      await codeOf(editTextFile({ path: target, old_text: 'absent', new_text: 'x', expected_sha256: v }, policy)),
      'EDIT_NOT_FOUND',
    );

    const replaced = await editTextFile(
      { path: target, old_text: 'same', new_text: 'x', replace_all: true, expected_sha256: v },
      policy,
    );
    assert.equal(replaced.replacements, 2);
    assert.equal(await readFile(target, 'utf8'), 'x\nx\n');
  } finally {
    await sandbox.cleanup();
  }
});

test('read returns a bounded whole file, pages exactly, and enforces max_bytes', async () => {
  const sandbox = await makeSandbox();
  try {
    const target = join(sandbox.root, 'big.txt');
    const lines = Array.from({ length: 4000 }, (_, index) => `line-${String(index).padStart(4, '0')}`).join('\n');
    await writeFixture(target, lines);
    const fullBytes = Buffer.byteLength(lines);
    const lastLine = 'line-3999';

    const policy = policyFor(sandbox, {
      limits: { readMaxBytes: 256, readMaxLines: 5, readMaxWindowBytes: 1 << 20 },
    });

    const firstPage = await readTextFile({ path: target }, policy);
    assert.equal(firstPage.lines_returned, 5, 'page size bounds the number of lines');
    assert.equal(firstPage.line_end, 5);
    assert.equal(firstPage.next_line, 6, 'next_line must let a caller advance');
    assert.equal(firstPage.line_count_complete, true, 'the whole file was read, so the line count is exact');
    assert.equal(firstPage.line_count, 4000);
    assert.equal(firstPage.file_version.complete, true);
    assert.equal(firstPage.file_version.bytes_hashed, fullBytes, 'the version covers the whole file');
    assert.ok(Buffer.byteLength(firstPage.content) <= 256, 'max_bytes bounds the returned content');

    // The LAST page is reachable: the whole file is in memory, so a later range
    // is not lost behind the first byte budget.
    const lastPage = await readTextFile({ path: target, start_line: 3998 }, policy);
    assert.equal(lastPage.lines_returned, 3);
    assert.ok(lastPage.content.includes(lastLine), `tail not reachable: ${JSON.stringify(lastPage.content)}`);
    assert.equal(lastPage.line_end, 4000);
    assert.equal(lastPage.next_line, undefined);

    // A page in the middle, and the same whole-file version every time.
    const middle = await readTextFile({ path: target, start_line: 2000, end_line: 2002 }, policy);
    assert.equal(middle.lines_returned, 3);
    assert.ok(middle.content.startsWith('line-1999'));
    assert.equal(middle.file_version.sha256, firstPage.file_version.sha256);
    assert.equal(middle.file_version.sha256, lastPage.file_version.sha256);

    // max_bytes is a hard bound on the returned content, and the page advances.
    const tiny = await readTextFile({ path: target, max_bytes: 100 }, policy);
    assert.ok(Buffer.byteLength(tiny.content) <= 100, `returned ${Buffer.byteLength(tiny.content)} bytes for max_bytes=100`);
    assert.ok(tiny.lines_returned > 0);
    assert.ok(tiny.next_line !== undefined && tiny.next_line > tiny.line_start);

    // An explicit end_line wider than the page size is capped and explained.
    const explicit = await readTextFile({ path: target, start_line: 1, end_line: 40 }, policy);
    assert.equal(explicit.truncation, 'line_range');
    assert.equal(explicit.line_end, 5);
    assert.equal(explicit.line_window_capped, true);

    // A whole-file request within every budget reports no truncation.
    const whole = policyFor(sandbox, {
      limits: { readMaxBytes: 1 << 20, readMaxLines: 5000, readMaxWindowBytes: 1 << 21 },
    });
    const complete = await readTextFile({ path: target }, whole);
    assert.equal(complete.truncation, 'none');
    assert.equal(complete.line_window_capped, false);
    assert.equal(complete.content, lines);
  } finally {
    await sandbox.cleanup();
  }
});

test('a file larger than the read window is refused explicitly, never partially returned', async () => {
  const sandbox = await makeSandbox();
  try {
    const target = join(sandbox.root, 'huge.txt');
    await writeFixture(target, 'x'.repeat(4096));
    const policy = policyFor(sandbox, { limits: { readMaxWindowBytes: 1024, readMaxBytes: 1 << 20, readMaxLines: 5000 } });
    assert.equal(await codeOf(readTextFile({ path: target }, policy)), 'FILE_TOO_LARGE');

    // Just inside the window still works.
    const small = join(sandbox.root, 'small.txt');
    await writeFixture(small, 'y'.repeat(1024));
    const ok = await readTextFile({ path: small }, policy);
    assert.equal(ok.file_version.complete, true);
    assert.equal(ok.file_version.size, 1024);
  } finally {
    await sandbox.cleanup();
  }
});

test('a line longer than the byte budget reports line_too_long instead of dropping content', async () => {
  const sandbox = await makeSandbox();
  try {
    const target = join(sandbox.root, 'longline.txt');
    const longLine = 'L'.repeat(5000);
    await writeFixture(target, `${longLine}\nshort\n`);
    const policy = policyFor(sandbox, { limits: { readMaxBytes: 100, readMaxLines: 10, readMaxWindowBytes: 1 << 20 } });

    const result = await readTextFile({ path: target }, policy);
    assert.equal(result.truncation, 'line_too_long');
    assert.equal(result.content, '', 'content must not be silently clipped mid-line');
    assert.equal(result.lines_returned, 0);
    assert.equal(result.file_version.size, 5007);
    assert.equal(result.file_version.complete, true);

    // Starting at the short line works, which is how a caller makes progress.
    // The file ends with a newline, so line 3 is the empty final line.
    const second = await readTextFile({ path: target, start_line: 2 }, policy);
    assert.equal(second.content, 'short\n', 'the trailing newline makes line 3 empty');
    assert.equal(second.lines_returned, 2);
    assert.equal(second.truncation, 'none');
  } finally {
    await sandbox.cleanup();
  }
});

test('multi-byte UTF-8 is counted in bytes, not characters', async () => {
  const sandbox = await makeSandbox();
  try {
    const target = join(sandbox.root, 'cjk.txt');
    const lines = ['中文测试行', '第二行内容', '第三行结束'];
    await writeFixture(target, `${lines.join('\n')}\n`);
    const policy = policyFor(sandbox, { limits: { readMaxBytes: 1 << 20, readMaxLines: 10, readMaxWindowBytes: 1 << 20 } });

    const all = await readTextFile({ path: target }, policy);
    assert.equal(all.content, `${lines.join('\n')}\n`);
    assert.equal(all.lines_returned, 4, 'the trailing newline yields a final empty line');
    assert.equal(all.file_version.size, Buffer.byteLength(`${lines.join('\n')}\n`));

    // A budget that fits exactly two CJK lines (5 chars * 3 bytes + newline).
    const twoLineBudget = policyFor(sandbox, { limits: { readMaxBytes: 33, readMaxLines: 10, readMaxWindowBytes: 1 << 20 } });
    const clipped = await readTextFile({ path: target }, twoLineBudget);
    assert.ok(Buffer.byteLength(clipped.content) <= 33, `returned ${Buffer.byteLength(clipped.content)} bytes`);
    assert.ok(clipped.content.startsWith('中文测试行'));
    assert.equal(clipped.line_end, 2);
  } finally {
    await sandbox.cleanup();
  }
});

test('a file that changes during the read is refused, not mixed', async () => {
  const sandbox = await makeSandbox();
  try {
    const target = join(sandbox.root, 'changing.txt');
    const policy = policyFor(sandbox, { limits: { readMaxBytes: 1 << 20, readMaxLines: 100, readMaxWindowBytes: 1 << 20 } });
    // A big-ish file keeps the read window wide enough for a concurrent writer
    // to land between the two stat calls reliably enough to be worth asserting.
    await writeFixture(target, `${'a'.repeat(1024 * 512)}\n`);

    let mutated = false;
    const mutation = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      await writeFile(target, `${'b'.repeat(1024 * 512)}\n`);
      mutated = true;
    })();

    let outcome;
    try {
      outcome = { result: await readTextFile({ path: target }, policy) };
    } catch (error) {
      outcome = { error };
    }
    await mutation;

    if (outcome.error !== undefined) {
      assert.equal(outcome.error.code, 'VERSION_CONFLICT', `unexpected error: ${outcome.error.code}`);
      assert.equal(mutated, true);
    } else {
      // If the write had not landed yet the read is a consistent snapshot; what
      // must never happen is a hash that does not match the returned content.
      const returned = outcome.result;
      assert.equal(
        returned.file_version.sha256,
        createHash('sha256').update(Buffer.from(returned.content, 'utf8')).digest('hex'),
        'a successful read must hash exactly the content it returned',
      );
      assert.equal(returned.file_version.complete, true);
    }
  } finally {
    await sandbox.cleanup();
  }
});

test('an empty file reports empty, not a fake truncation', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox);
    const target = join(sandbox.root, 'empty.txt');
    await writeFixture(target, '');
    const result = await readTextFile({ path: target }, policy);
    assert.equal(result.content, '');
    assert.equal(result.truncation, 'empty');
    assert.equal(result.line_count, 0);
    assert.equal(result.line_start, 0);
    assert.equal(result.file_version.size, 0);
  } finally {
    await sandbox.cleanup();
  }
});

test('paths outside every trusted root are refused', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox);
    const outsideFile = join(sandbox.outside, 'secret.txt');
    await writeFixture(outsideFile, 'not yours\n');

    assert.equal(await codeOf(readTextFile({ path: outsideFile }, policy)), 'PATH_OUTSIDE_ROOTS');
    assert.equal(await codeOf(writeTextFile({ path: join(sandbox.outside, 'new.txt'), content: 'x' }, policy)), 'PATH_OUTSIDE_ROOTS');
    assert.equal(await codeOf(readTextFile({ path: '/etc/hosts' }, policy)), 'PATH_OUTSIDE_ROOTS');
    assert.equal(await codeOf(readTextFile({ path: 'relative/path.txt' }, policy)), 'INVALID_PATH');
    assert.equal(await codeOf(readTextFile({ path: '..' }, policy)), 'INVALID_PATH');
    assert.equal(await codeOf(readTextFile({ path: '' }, policy)), 'INVALID_PATH');
  } finally {
    await sandbox.cleanup();
  }
});

test('traversal and symlink escapes are refused', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox);
    await mkdir(join(sandbox.root, 'sub'), { recursive: true });
    await writeFixture(join(sandbox.outside, 'target.txt'), 'outside\n');

    // `..` traversal out of the root.
    const traversal = join(sandbox.root, 'sub', '..', '..', 'outside', 'target.txt');
    assert.equal(await codeOf(readTextFile({ path: traversal }, policy)), 'PATH_OUTSIDE_ROOTS');

    // Symlinked file pointing outside the root.
    const link = join(sandbox.root, 'escape.txt');
    await makeSymlink(join(sandbox.outside, 'target.txt'), link);
    assert.equal(await codeOf(readTextFile({ path: link }, policy)), 'PATH_OUTSIDE_ROOTS');

    // Symlinked DIRECTORY escaping the root, read through it.
    const dirLink = join(sandbox.root, 'escape-dir');
    await makeSymlink(sandbox.outside, dirLink);
    assert.equal(await codeOf(readTextFile({ path: join(dirLink, 'target.txt') }, policy)), 'PATH_OUTSIDE_ROOTS');

    // Symlinked parent used as a write path.
    assert.equal(
      await codeOf(writeTextFile({ path: join(dirLink, 'planted.txt'), content: 'x' }, policy)),
      'PATH_OUTSIDE_ROOTS',
    );

    // A symlink that stays inside the root is still accepted for reading.
    const insideLink = join(sandbox.root, 'inside-link.txt');
    await writeFixture(join(sandbox.root, 'real.txt'), 'inside\n');
    await makeSymlink(join(sandbox.root, 'real.txt'), insideLink);
    const viaLink = await readTextFile({ path: insideLink }, policy);
    assert.equal(viaLink.content, 'inside\n');
  } finally {
    await sandbox.cleanup();
  }
});

test('credential-shaped paths and names are refused for read and write', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox);
    await mkdir(join(sandbox.root, '.ssh'), { recursive: true });
    await writeFixture(join(sandbox.root, '.ssh', 'config'), 'Host *\n');
    await writeFixture(join(sandbox.root, '.env'), 'API_KEY=supersecretvalue\n');
    await writeFixture(join(sandbox.root, 'server.pem'), '-----BEGIN PRIVATE KEY-----\n');
    await writeFixture(join(sandbox.root, 'id_ed25519'), 'key\n');

    assert.equal(await codeOf(readTextFile({ path: join(sandbox.root, '.ssh', 'config') }, policy)), 'PATH_DENIED');
    assert.equal(await codeOf(readTextFile({ path: join(sandbox.root, '.env') }, policy)), 'PATH_DENIED');
    assert.equal(await codeOf(readTextFile({ path: join(sandbox.root, 'server.pem') }, policy)), 'PATH_DENIED');
    assert.equal(await codeOf(readTextFile({ path: join(sandbox.root, 'id_ed25519') }, policy)), 'PATH_DENIED');
    assert.equal(
      await codeOf(writeTextFile({ path: join(sandbox.root, '.env'), content: 'x' }, policy)),
      'PATH_DENIED',
    );
    assert.equal(
      await codeOf(writeTextFile({ path: join(sandbox.root, 'fresh.pem'), content: 'x' }, policy)),
      'PATH_DENIED',
    );

    // A denial must not echo the secret value it protected.
    const error = await readTextFile({ path: join(sandbox.root, '.env') }, policy).catch((caught) => caught);
    assert.ok(!JSON.stringify(error.details ?? {}).includes('supersecretvalue'), 'refusal must not leak file content');
    assert.equal(error.code, 'PATH_DENIED');
  } finally {
    await sandbox.cleanup();
  }
});

test('binary files and missing files are refused with stable codes', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox);
    const binary = join(sandbox.root, 'blob.bin');
    await writeFile(binary, Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]));
    assert.equal(await codeOf(readTextFile({ path: binary }, policy)), 'IS_BINARY');
    assert.equal(await codeOf(readTextFile({ path: join(sandbox.root, 'nope.txt') }, policy)), 'NOT_FOUND');
    assert.equal(
      await codeOf(editTextFile(
        { path: join(sandbox.root, 'nope.txt'), old_text: 'a', new_text: 'b', expected_sha256: 'deadbeefdeadbeef' },
        policy,
      )),
      'NOT_FOUND',
    );
    assert.equal(await codeOf(readTextFile({ path: sandbox.root }, policy)), 'NOT_A_FILE');
  } finally {
    await sandbox.cleanup();
  }
});

test('writes are refused when the policy allows no writable root', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = readOnlyPolicy(sandbox);
    const target = join(sandbox.root, 'read-only.txt');
    await writeFixture(target, 'original\n');

    assert.equal(await codeOf(writeTextFile({ path: target, content: 'x' }, policy)), 'WRITE_DISABLED');
    assert.equal(await codeOf(editTextFile({ path: target, old_text: 'original', new_text: 'x' }, policy)), 'WRITE_DISABLED');
    assert.equal(await readFile(target, 'utf8'), 'original\n');

    // Reading still works: the toggle is per capability.
    const read = await readTextFile({ path: target }, policy);
    assert.equal(read.content, 'original\n');
  } finally {
    await sandbox.cleanup();
  }
});

test('the whole direct surface is refused when disabled', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox, { enabled: false });
    const target = join(sandbox.root, 'x.txt');
    await writeFixture(target, 'x\n');
    assert.equal(policy.enabled, false);
    assert.equal(await codeOf(readTextFile({ path: target }, policy)), 'DIRECT_OPS_DISABLED');
    assert.equal(await codeOf(writeTextFile({ path: target, content: 'y' }, policy)), 'DIRECT_OPS_DISABLED');
    assert.equal(
      await codeOf(editTextFile({ path: target, old_text: 'x', new_text: 'y' }, policy)),
      'DIRECT_OPS_DISABLED',
    );
  } finally {
    await sandbox.cleanup();
  }
});

test('a root that does not exist is a config error, not a silent skip', async () => {
  const sandbox = await makeSandbox();
  try {
    assert.throws(
      () => policyFor(sandbox, { roots: [join(sandbox.base, 'missing-root')], writableRoots: [] }),
      (error) => error.code === 'INVALID_ARGUMENT',
    );
  } finally {
    await sandbox.cleanup();
  }
});

test('writes are atomic: no temp files are left behind', async () => {
  const sandbox = await makeSandbox();
  try {
    const policy = policyFor(sandbox);
    const target = join(sandbox.root, 'atomic.txt');
    const first = await writeTextFile({ path: target, content: 'v1' }, policy);
    await writeTextFile(
      { path: target, content: 'v2', mode: 'overwrite', expected_sha256: first.file_version.sha256 },
      policy,
    );
    const info = await stat(target);
    assert.ok(info.isFile());
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(sandbox.root);
    assert.deepEqual(entries.filter((name) => name.includes('dsh-direct-')), [], 'no temp file may survive a write');
    assert.equal(await readFile(target, 'utf8'), 'v2');
  } finally {
    await sandbox.cleanup();
  }
});

test('writableRoots must name an actual root; a read-only root stays read-only', async () => {
  const sandbox = await makeSandbox();
  try {
    const readOnlyRoot = join(sandbox.base, 'ro');
    await mkdir(readOnlyRoot, { recursive: true });
    await writeFixture(join(readOnlyRoot, 'a.txt'), 'a\n');
    const policy = policyFor(sandbox, { roots: [sandbox.root, readOnlyRoot], writableRoots: [sandbox.root] });
    assert.equal(policy.roots.length, 2);
    assert.equal(policy.roots.find((root) => root.label.endsWith('/ro'))?.writable, false);
    assert.equal(
      await codeOf(writeTextFile({ path: join(readOnlyRoot, 'b.txt'), content: 'x' }, policy)),
      'PATH_OUTSIDE_ROOTS',
    );
    assert.equal(await readTextFile({ path: join(readOnlyRoot, 'a.txt') }, policy).then((r) => r.content), 'a\n');
  } finally {
    await sandbox.cleanup();
  }
});

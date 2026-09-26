/**
 * Direct file operations: read, write, edit.
 *
 * Conflict model (the part that matters for not clobbering an agent):
 *   - every read returns a `file_version` describing exactly the bytes it read:
 *     sha256 of those bytes, the byte count reached, the file's total size and
 *     mtime. Content and hash come from the SAME read, so they can never
 *     describe two different revisions of the file;
 *   - reads are paginated, and asking for a later line range really does read
 *     further into the file instead of being capped forever by the first byte
 *     budget. Pagination stops at a bounded read window;
 *   - every write and every edit REQUIRES the version the caller read. A
 *     mismatch fails closed with VERSION_CONFLICT and the current version,
 *     instead of overwriting the other writer's work;
 *   - `mode: "create"` is genuinely no-clobber: the file is placed with an
 *     atomic link, so a file that appears between the check and the commit makes
 *     the operation fail rather than silently turning into a replace;
 *   - overwrite and edit preserve the target's permission bits; new files are
 *     created 0600.
 * An advisory FIFO per-path lock serializes concurrent direct writes in this
 * process. `agents` and other processes are covered by the version check, not by
 * the lock, and the check is optimistic: see the residual race documented in
 * docs/direct-operations.md.
 */
import { createHash, randomBytes } from 'node:crypto';
import { link as linkAsync, mkdir as mkdirAsync, open as openAsync, rename as renameAsync, rm as rmAsync, stat as statAsync, } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveExistingTarget, resolveWritableTarget } from './path-security.js';
import { scrubPathForDisplay } from './secrets.js';
import { DirectOpsError } from './types.js';
/**
 * FIFO mutex.
 *
 * The earlier tail-promise design leaked the lock to a *later* waiter when the
 * middle waiter timed out: the timed-out waiter released a gate that the next
 * waiter was chained to, so two writers could run at once. This queue version
 * removes a timed-out waiter from the queue and hands the lock directly to the
 * next real waiter.
 */
class PathLocks {
    held = new Map();
    queue = new Map();
    async withLock(key, fn, waitMs = 10000) {
        await this.acquire(key, waitMs);
        try {
            return await fn();
        }
        finally {
            this.release(key);
        }
    }
    acquire(key, waitMs) {
        if (this.held.get(key) !== true) {
            this.held.set(key, true);
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            const waiters = this.queue.get(key) ?? [];
            const entry = {
                grant: () => {
                    clearTimeout(timer);
                    resolve();
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            };
            const timer = setTimeout(() => {
                // Dequeue first: a waiter that gave up must not hold a slot that the
                // release path would hand to nobody.
                const current = this.queue.get(key) ?? [];
                const index = current.indexOf(entry);
                if (index >= 0)
                    current.splice(index, 1);
                if (current.length === 0)
                    this.queue.delete(key);
                reject(new DirectOpsError('LOCK_BUSY', 'another direct write to the same path is still running', {
                    path: scrubPathForDisplay(key),
                }));
            }, waitMs);
            timer.unref?.();
            waiters.push(entry);
            this.queue.set(key, waiters);
        });
    }
    release(key) {
        const waiters = this.queue.get(key) ?? [];
        const next = waiters.shift();
        if (waiters.length === 0)
            this.queue.delete(key);
        if (next !== undefined) {
            next.grant();
            return;
        }
        this.held.delete(key);
    }
    /** Test seam: how many waiters are queued for a path right now. */
    queuedFor(key) {
        return (this.queue.get(key) ?? []).length;
    }
}
export const pathLocks = new PathLocks();
function sha256(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}
function isBinary(buffer) {
    if (buffer.includes(0))
        return true;
    const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
    let suspicious = 0;
    for (const byte of sample) {
        if (byte < 7 || (byte > 14 && byte < 32))
            suspicious += 1;
    }
    return sample.length > 0 && suspicious / sample.length > 0.1;
}
/** Keep the BOM in the text so an edit round trip cannot silently drop it. */
function keepBom(text) {
    return text.startsWith('\uFEFF') ? { text, bom: true } : { text, bom: false };
}
async function readWholeFileStable(path, maxBytes) {
    let handle;
    try {
        handle = await openAsync(path, 'r');
    }
    catch (error) {
        const code = error.code;
        if (code === 'EACCES' || code === 'EPERM') {
            throw new DirectOpsError('NOT_READABLE', 'the OS refused to open this file for reading (permission denied)', {
                path: scrubPathForDisplay(path),
            });
        }
        throw new DirectOpsError('NOT_FOUND', 'file could not be opened for reading', {
            path: scrubPathForDisplay(path),
        });
    }
    try {
        const before = await handle.stat();
        if (!before.isFile()) {
            throw new DirectOpsError('NOT_A_FILE', 'path is not a regular file', { path: scrubPathForDisplay(path) });
        }
        if (before.size > maxBytes) {
            throw new DirectOpsError('FILE_TOO_LARGE', 'file is larger than the configured read window; this surface reads a whole file so that the content and '
                + 'its version are provably the same revision, and refuses rather than returning a partial file', { size: before.size, limit: maxBytes, path: scrubPathForDisplay(path) });
        }
        const buffer = Buffer.allocUnsafe(before.size);
        let filled = 0;
        while (filled < before.size) {
            const chunk = await handle.read(buffer, filled, before.size - filled, filled);
            if (chunk.bytesRead === 0)
                break;
            filled += chunk.bytesRead;
        }
        const after = await handle.stat();
        const unchanged = filled === before.size
            && after.size === before.size
            && after.mtimeMs === before.mtimeMs
            && after.ctimeMs === before.ctimeMs
            && after.dev === before.dev
            && after.ino === before.ino;
        if (!unchanged) {
            throw new DirectOpsError('VERSION_CONFLICT', 'file changed while it was being read (size, mtime, ctime, device or inode differ); re-read to get a '
                + 'consistent version instead of a mix of two revisions', {
                path: scrubPathForDisplay(path),
                bytes_expected: before.size,
                bytes_read: filled,
                size_before: before.size,
                size_after: after.size,
            });
        }
        return { buffer, size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs };
    }
    finally {
        await handle.close();
    }
}
/** Version of a buffer that was already read completely and identity-checked. */
function versionOfCompleteFile(buffer, size, mtimeMs) {
    return {
        sha256: sha256(buffer),
        bytes_hashed: buffer.length,
        size,
        mtime_ms: Math.trunc(mtimeMs),
        complete: true,
    };
}
export async function readTextFile(input, policy) {
    const started = Date.now();
    if (!policy.enabled) {
        throw new DirectOpsError('DIRECT_OPS_DISABLED', 'direct operations are disabled by the host configuration');
    }
    const target = resolveExistingTarget(input.path, policy);
    const { buffer, size, mtimeMs } = await readWholeFileStable(target.canonical, policy.limits.readMaxWindowBytes);
    if (isBinary(buffer)) {
        throw new DirectOpsError('IS_BINARY', 'file does not look like UTF-8 text; refusing to return it', {
            path: scrubPathForDisplay(target.canonical),
            probed_bytes: buffer.length,
        });
    }
    const version = versionOfCompleteFile(buffer, size, mtimeMs);
    const { text, bom } = keepBom(buffer.toString('utf8'));
    // Budgets are enforced on what is RETURNED, not on how much was read: the whole
    // file is in memory, so paging is exact and a later page is always reachable.
    const budget = Math.min(input.max_bytes !== undefined && input.max_bytes > 0 ? input.max_bytes : policy.limits.readMaxBytes, policy.limits.readMaxBytes);
    const maxLines = policy.limits.readMaxLines;
    const allLines = text === '' ? [] : text.split('\n');
    const totalLines = allLines.length;
    const startLine = Math.max(1, Math.trunc(input.start_line ?? 1));
    const requestedEnd = input.end_line !== undefined ? Math.trunc(input.end_line) : totalLines;
    if (totalLines === 0) {
        return {
            path: target.canonical,
            root: target.root.label,
            file_version: version,
            encoding: bom ? 'utf-8-bom' : 'utf-8',
            line_count: 0,
            line_count_complete: true,
            line_start: 0,
            line_end: 0,
            lines_returned: 0,
            truncated: false,
            truncation: 'empty',
            line_window_capped: false,
            binary: false,
            content: '',
            duration_ms: Date.now() - started,
        };
    }
    if (startLine > totalLines) {
        throw new DirectOpsError('INVALID_ARGUMENT', `start_line ${startLine} is past the end of the file (${totalLines} lines)`, { path: scrubPathForDisplay(target.canonical), line_count: totalLines });
    }
    const lines = [];
    let bytesUsed = 0;
    let lineTooLong = false;
    let endLine = startLine - 1;
    for (let index = startLine - 1; index < totalLines; index += 1) {
        if (lines.length >= maxLines)
            break;
        if (index + 1 > requestedEnd)
            break;
        const line = allLines[index];
        const lineBytes = Buffer.byteLength(line, 'utf8') + (lines.length === 0 ? 0 : 1);
        if (lines.length === 0 && lineBytes > budget) {
            // A single line larger than the whole budget cannot be returned without
            // silently dropping content, so say exactly that.
            lineTooLong = true;
            break;
        }
        if (bytesUsed + lineBytes > budget)
            break;
        bytesUsed += lineBytes;
        lines.push(line);
        endLine = index + 1;
    }
    const content = lines.join('\n');
    const lineWindowCapped = endLine < requestedEnd || (input.end_line === undefined && totalLines > endLine);
    const truncation = lineTooLong
        ? 'line_too_long'
        : endLine === 0
            ? 'byte_budget'
            : lineWindowCapped
                ? (lines.length >= maxLines ? 'line_range' : 'byte_budget')
                : 'none';
    return {
        path: target.canonical,
        root: target.root.label,
        file_version: version,
        encoding: bom ? 'utf-8-bom' : 'utf-8',
        line_count: totalLines,
        line_count_complete: true,
        line_start: lines.length === 0 ? 0 : startLine,
        line_end: lines.length === 0 ? 0 : endLine,
        lines_returned: lines.length,
        truncated: truncation !== 'none',
        truncation,
        line_window_capped: lineWindowCapped,
        ...(lines.length > 0 && endLine < totalLines ? { next_line: endLine + 1 } : {}),
        binary: false,
        content,
        duration_ms: Date.now() - started,
    };
}
/**
 * Verify a file immediately after this call committed it.
 *
 * Three independent checks, because a post-commit read is not trustworthy on its
 * own:
 *   1. the path must still resolve to the SAME canonical file we committed to —
 *      a redirected path means a symlink was swapped under us, and we must not
 *      chase the write to some other location;
 *   2. the file's bytes must hash to the digest of the content THIS call wrote,
 *      so a same-length replacement by a third party is caught instead of being
 *      reported as our success;
 *   3. the file's identity (size, mtime, ctime, device, inode) must be identical
 *      before and after our own read, so the digest and the metadata describe one
 *      revision.
 *
 * Any failure here is reported as POST_COMMIT_CONFLICT with `committed: true`:
 * the write DID happen, but it could not be verified. The caller is told the
 * outcome plainly and is not told to retry, because a retry could overwrite
 * whatever actually landed.
 */
async function verifyCommittedContent(path, expectedSha256, expectedSize) {
    const handle = await openAsync(path, 'r');
    try {
        const before = await handle.stat();
        if (before.size !== expectedSize) {
            throw postCommitConflict(path, 'the committed file does not have the size this call wrote', {
                expected_size: expectedSize,
                actual_size: before.size,
            });
        }
        const hash = createHash('sha256');
        const buffer = Buffer.allocUnsafe(expectedSize);
        let filled = 0;
        while (filled < expectedSize) {
            const { bytesRead } = await handle.read(buffer, filled, expectedSize - filled, filled);
            if (bytesRead === 0)
                break;
            filled += bytesRead;
        }
        const after = await handle.stat();
        const selfConsistent = filled === expectedSize
            && after.size === before.size
            && after.mtimeMs === before.mtimeMs
            && after.ctimeMs === before.ctimeMs
            && after.dev === before.dev
            && after.ino === before.ino;
        if (!selfConsistent) {
            throw postCommitConflict(path, 'the committed file changed while it was being read back', {
                bytes_read: filled,
                expected_size: expectedSize,
            });
        }
        hash.update(buffer.subarray(0, filled));
        const actual = hash.digest('hex');
        if (actual !== expectedSha256) {
            throw postCommitConflict(path, 'the file no longer holds the content this call wrote (a same-length replacement is detected here); the '
                + 'write did happen, so this is reported as an unverified commit rather than a failed one', { expected_sha256: expectedSha256, actual_sha256: actual });
        }
        return { sha256: actual, size: after.size, mtimeMs: after.mtimeMs };
    }
    finally {
        await handle.close();
    }
}
/** A commit that happened but could not be verified. Never tells the caller to just retry. */
function postCommitConflict(path, message, details) {
    return new DirectOpsError('POST_COMMIT_CONFLICT', `${message}. The write already happened; do not blindly retry — read the file to see what is there now.`, { path: scrubPathForDisplay(path), committed: true, ...details });
}
async function currentVersion(path, maxBytes) {
    const { buffer, size, mtimeMs } = await readWholeFileStable(path, maxBytes);
    return versionOfCompleteFile(buffer, size, mtimeMs);
}
function assertVersionMatch(expected, actual, path) {
    if (expected !== actual.sha256) {
        throw new DirectOpsError('VERSION_CONFLICT', 'file changed since it was read; re-read it and retry with the current file_version.sha256'
            + ' (this guard is what stops ChatGPT and a DSH agent from overwriting each other)', { path: scrubPathForDisplay(path), expected_sha256: expected, actual_sha256: actual.sha256 });
    }
}
async function pathMode(path) {
    try {
        const info = await statAsync(path);
        return info.mode & 0o777;
    }
    catch {
        return undefined;
    }
}
/**
 * Commit `content` at `path`.
 *
 * Ordering is deliberate and is the core of the commit guarantee:
 *   1. write the payload to a same-directory temp file and fsync it;
 *   2. **re-verify** the destination path and, for a replace, the expected content
 *      hash — after the (potentially slow) temp write, immediately before the
 *      commit, not before it;
 *   3. commit atomically: a hard link for a create (EEXIST ⇒ someone else won, so
 *      we refuse instead of replacing), an atomic rename for a replace.
 *
 * The temp file carries the destination's mode, and is fchmod'ed after creation,
 * because open() applies the process umask and would otherwise silently change
 * permission bits on replace.
 *
 * Residual race, stated plainly: between step 2's check and step 3's rename a
 * different process can still replace the file. This is not compare-and-swap and
 * does not claim to be; what it guarantees is that ChatGPT never commits over a
 * change it was able to observe, and that `create` can never clobber at all.
 * The returned hash is computed from the bytes THIS call wrote, so a file that a
 * third party replaces a moment later is not misreported as our success.
 */
async function commitContent(path, content, options) {
    const dir = dirname(path);
    const temp = `${dir}/.dsh-direct-${randomBytes(6).toString('hex')}.tmp`;
    const bytesWritten = Buffer.byteLength(content, 'utf8');
    // The digest of what we are about to write. Everything after the commit is
    // compared against THIS value, not against whatever the file happens to hold.
    const expectedSha256 = createHash('sha256').update(content, 'utf8').digest('hex');
    try {
        const handle = await openAsync(temp, 'wx', options.mode);
        try {
            await handle.writeFile(content, 'utf8');
            // open() masks the mode with the umask; a chmod failure must not be
            // swallowed, because it would leave a file with unexpected permissions.
            await handle.chmod(options.mode);
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        if (options.verify !== undefined)
            await options.verify(path);
        if (options.noClobber) {
            try {
                await linkAsync(temp, path);
            }
            catch (error) {
                if (error.code === 'EEXIST') {
                    throw new DirectOpsError('WRITE_CONFLICT', 'the target appeared while this create was in flight; refusing to replace it'
                        + ' (use mode=overwrite with expected_sha256 after re-reading)', { path: scrubPathForDisplay(path) });
                }
                throw error;
            }
            await rmAsync(temp, { force: true });
        }
        else {
            await renameAsync(temp, path);
        }
    }
    catch (error) {
        await rmAsync(temp, { force: true }).catch(() => undefined);
        if (error instanceof DirectOpsError)
            throw error;
        throw new DirectOpsError('INTERNAL', `write failed: ${error.message}`, {
            path: scrubPathForDisplay(path),
        });
    }
    // Post-commit verification. The write has already happened at this point, so a
    // failure here is reported as "committed but unverified", never as "failed".
    const verified = await verifyCommittedContent(path, expectedSha256, bytesWritten);
    return {
        size: verified.size,
        mode: (await pathMode(path)) ?? options.mode,
        version: {
            sha256: verified.sha256,
            bytes_hashed: verified.size,
            size: verified.size,
            mtime_ms: Math.trunc(verified.mtimeMs),
            complete: true,
        },
    };
}
export async function writeTextFile(input, policy) {
    const started = Date.now();
    if (!policy.enabled) {
        throw new DirectOpsError('DIRECT_OPS_DISABLED', 'direct operations are disabled by the host configuration');
    }
    if (!policy.writesEnabled) {
        throw new DirectOpsError('WRITE_DISABLED', 'direct writes are disabled: no trusted root is configured as writable, or allowWrites is false', { writable_roots: policy.roots.filter((root) => root.writable).map((root) => root.label) });
    }
    if (typeof input.content !== 'string') {
        throw new DirectOpsError('INVALID_ARGUMENT', 'content must be a string');
    }
    const bytes = Buffer.byteLength(input.content, 'utf8');
    if (bytes > policy.limits.writeMaxBytes) {
        throw new DirectOpsError('FILE_TOO_LARGE', 'content exceeds the configured write budget', {
            bytes,
            limit: policy.limits.writeMaxBytes,
        });
    }
    const target = resolveWritableTarget(input.path, policy);
    // Default is 'create', matching the tool schema: a write never replaces an
    // existing file unless the caller explicitly says so AND supplies a version.
    const mode = input.mode ?? 'create';
    return pathLocks.withLock(target.canonical, async () => {
        // Re-resolve inside the lock: the path may have changed between the caller's
        // read and this commit, and a symlink swap must not redirect the write.
        const confirmed = resolveWritableTarget(input.path, policy);
        const existsNow = confirmed.exists;
        const existingMode = existsNow ? await pathMode(confirmed.canonical) : undefined;
        if (mode === 'create' && existsNow) {
            throw new DirectOpsError('WRITE_CONFLICT', 'mode=create refuses to touch an existing file; read it and use mode=overwrite with expected_sha256 instead', { path: scrubPathForDisplay(confirmed.canonical) });
        }
        if (mode === 'overwrite' && !existsNow) {
            throw new DirectOpsError('NOT_FOUND', 'mode=overwrite requires an existing file; use mode=create for a new file', { path: scrubPathForDisplay(confirmed.canonical) });
        }
        if (mode === 'overwrite' && (input.expected_sha256 === undefined || input.expected_sha256 === '')) {
            throw new DirectOpsError('READ_REQUIRED', 'overwriting an existing file requires expected_sha256 from a read of the current content; this is what '
                + 'prevents overwriting work an agent or another tool did in the meantime', { path: scrubPathForDisplay(confirmed.canonical) });
        }
        const before = existsNow ? await currentVersion(confirmed.canonical, policy.limits.readMaxWindowBytes) : undefined;
        if (input.expected_sha256 !== undefined && input.expected_sha256 !== '') {
            if (before === undefined) {
                throw new DirectOpsError('VERSION_CONFLICT', 'expected_sha256 was supplied but the file does not exist', {
                    path: scrubPathForDisplay(confirmed.canonical),
                });
            }
            assertVersionMatch(input.expected_sha256, before, confirmed.canonical);
        }
        if (input.create_dirs === true) {
            await mkdirAsync(dirname(confirmed.canonical), { recursive: true });
        }
        // Preserve permission bits on replace; new files are private by default.
        const commitMode = existingMode ?? 0o600;
        const wrote = await commitContent(confirmed.canonical, input.content, {
            noClobber: mode === 'create',
            mode: commitMode,
            // Re-resolve the path and re-check the version AFTER the temp write, so a
            // change made during that write is caught before the commit.
            verify: async (canonical) => {
                const atCommit = resolveWritableTarget(input.path, policy);
                // The path must still resolve to the file we resolved when we started: a
                // symlink swapped in the meantime would redirect the write elsewhere.
                if (atCommit.canonical !== canonical || atCommit.canonical !== confirmed.canonical) {
                    throw new DirectOpsError('PATH_REDIRECTED', 'the target path now resolves to a different file than when this operation started; refusing to write '
                        + 'through a path that was redirected underneath it', { path: scrubPathForDisplay(canonical), resolved_now: scrubPathForDisplay(atCommit.canonical) });
                }
                if (mode === 'create') {
                    if (atCommit.exists) {
                        throw new DirectOpsError('WRITE_CONFLICT', 'the target appeared while this create was in flight; refusing to replace it', { path: scrubPathForDisplay(atCommit.canonical) });
                    }
                    return;
                }
                const current = await currentVersion(atCommit.canonical, policy.limits.readMaxWindowBytes);
                assertVersionMatch(input.expected_sha256, current, atCommit.canonical);
            },
        });
        return {
            path: confirmed.canonical,
            root: confirmed.root.label,
            created: !existsNow,
            bytes_written: wrote.size,
            file_version: wrote.version,
            ...(before === undefined ? {} : { previous_version: before }),
            mode: wrote.mode.toString(8).padStart(3, '0'),
            duration_ms: Date.now() - started,
        };
    });
}
export async function editTextFile(input, policy) {
    const started = Date.now();
    if (!policy.enabled) {
        throw new DirectOpsError('DIRECT_OPS_DISABLED', 'direct operations are disabled by the host configuration');
    }
    if (!policy.writesEnabled) {
        throw new DirectOpsError('WRITE_DISABLED', 'direct writes are disabled by the host configuration');
    }
    if (typeof input.old_text !== 'string' || input.old_text === '') {
        throw new DirectOpsError('INVALID_ARGUMENT', 'old_text must be a non-empty string');
    }
    if (typeof input.new_text !== 'string') {
        throw new DirectOpsError('INVALID_ARGUMENT', 'new_text must be a string');
    }
    if (input.expected_sha256 === undefined || input.expected_sha256 === '') {
        throw new DirectOpsError('READ_REQUIRED', 'editing requires expected_sha256 from a read of the current content; a blind edit can silently apply to a '
            + 'revision the caller never saw', { path: scrubPathForDisplay(input.path) });
    }
    const maxReplacements = input.max_replacements ?? 100;
    const target = resolveWritableTarget(input.path, policy);
    if (!target.exists) {
        throw new DirectOpsError('NOT_FOUND', 'edit target does not exist; use dsh_write_text_file to create it', {
            path: scrubPathForDisplay(target.canonical),
        });
    }
    return pathLocks.withLock(target.canonical, async () => {
        const confirmed = resolveWritableTarget(input.path, policy);
        if (!confirmed.exists) {
            throw new DirectOpsError('NOT_FOUND', 'edit target disappeared before the edit could be applied', {
                path: scrubPathForDisplay(confirmed.canonical),
            });
        }
        const info = await statAsync(confirmed.canonical);
        if (info.size > policy.limits.writeMaxBytes) {
            throw new DirectOpsError('FILE_TOO_LARGE', 'file exceeds the edit budget; edit it with smaller operations', {
                size: info.size,
                limit: policy.limits.writeMaxBytes,
            });
        }
        const { buffer } = await readWholeFileStable(confirmed.canonical, policy.limits.writeMaxBytes);
        if (isBinary(buffer)) {
            throw new DirectOpsError('IS_BINARY', 'edit target does not look like UTF-8 text', {
                path: scrubPathForDisplay(confirmed.canonical),
            });
        }
        const before = versionOfCompleteFile(buffer, info.size, info.mtimeMs);
        assertVersionMatch(input.expected_sha256, before, confirmed.canonical);
        const current = keepBom(buffer.toString('utf8')).text;
        const occurrences = countOccurrences(current, input.old_text);
        if (occurrences === 0) {
            throw new DirectOpsError('EDIT_NOT_FOUND', 'old_text was not found in the file', {
                path: scrubPathForDisplay(confirmed.canonical),
            });
        }
        if (!input.replace_all && occurrences > 1) {
            throw new DirectOpsError('EDIT_AMBIGUOUS', 'old_text occurs more than once; add surrounding context or set replace_all=true', { path: scrubPathForDisplay(confirmed.canonical), occurrences });
        }
        if (input.replace_all && occurrences > maxReplacements) {
            throw new DirectOpsError('TOO_MANY_EDITS', 'replace_all would exceed max_replacements', {
                occurrences,
                max_replacements: maxReplacements,
            });
        }
        // Literal replacement: split/join, never String.replace, so `$&`, `$1` and
        // `$$` in new_text stay literal bytes instead of being interpreted.
        const next = input.replace_all
            ? current.split(input.old_text).join(input.new_text)
            : current.slice(0, current.indexOf(input.old_text))
                + input.new_text
                + current.slice(current.indexOf(input.old_text) + input.old_text.length);
        const nextBytes = Buffer.byteLength(next, 'utf8');
        if (nextBytes > policy.limits.writeMaxBytes) {
            throw new DirectOpsError('FILE_TOO_LARGE', 'edited content exceeds the configured write budget', {
                bytes: nextBytes,
                limit: policy.limits.writeMaxBytes,
            });
        }
        const wrote = await commitContent(confirmed.canonical, next, {
            noClobber: false,
            // Preserve the file's exact bits: `|| 0o600` would turn a deliberate 000
            // into 0600, which is a permission escalation, not a fallback.
            mode: info.mode & 0o777,
            // The edit's own version check happens before the temp write; repeat it
            // immediately before the commit so a change during that window is caught.
            verify: async (canonical) => {
                const atCommit = resolveWritableTarget(input.path, policy);
                if (atCommit.canonical !== canonical || atCommit.canonical !== confirmed.canonical) {
                    throw new DirectOpsError('PATH_REDIRECTED', 'the target path now resolves to a different file than when this edit started; refusing to write '
                        + 'through a path that was redirected underneath it', { path: scrubPathForDisplay(canonical), resolved_now: scrubPathForDisplay(atCommit.canonical) });
                }
                if (!atCommit.exists) {
                    throw new DirectOpsError('NOT_FOUND', 'edit target disappeared before the commit', {
                        path: scrubPathForDisplay(atCommit.canonical),
                    });
                }
                const current = await currentVersion(atCommit.canonical, policy.limits.readMaxWindowBytes);
                assertVersionMatch(input.expected_sha256, current, atCommit.canonical);
            },
        });
        const firstLine = lineOfFirstOccurrence(next, input.new_text);
        return {
            path: confirmed.canonical,
            root: confirmed.root.label,
            created: false,
            bytes_written: wrote.size,
            file_version: wrote.version,
            previous_version: before,
            mode: wrote.mode.toString(8).padStart(3, '0'),
            replacements: input.replace_all ? occurrences : 1,
            ...(firstLine === undefined ? {} : { first_replacement_line: firstLine }),
            duration_ms: Date.now() - started,
        };
    });
}
function countOccurrences(haystack, needle) {
    let count = 0;
    let index = haystack.indexOf(needle);
    while (index !== -1) {
        count += 1;
        index = haystack.indexOf(needle, index + needle.length);
    }
    return count;
}
function lineOfFirstOccurrence(text, needle) {
    if (needle === '')
        return undefined;
    const index = text.indexOf(needle);
    if (index === -1)
        return undefined;
    return text.slice(0, index).split('\n').length;
}
/** Version of a file without returning its content. */
export async function versionOfFile(path, policy) {
    const target = resolveExistingTarget(path, policy);
    return currentVersion(target.canonical, policy.limits.readMaxWindowBytes);
}

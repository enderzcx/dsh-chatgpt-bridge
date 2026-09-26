/**
 * Fail-safe ownership + cleanup for Goal-created temporary paths.
 * Never deletes unmarked user files or the workspace root.
 */
import { existsSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseMkdirPaths, parseWorktreeAddPath, } from './goal-facts.js';
import { pathsEqual } from './paths.js';
const RELEASE_NOTES = /(?:^|[/\\])release-notes-v[^/\\]+\.md$/i;
/**
 * Top-level names that mark a directory as a finished deliverable rather than a
 * scratch worktree. If any is present, cleanup leaves the path alone.
 */
const DELIVERABLE_MARKERS = ['FINAL-DELIVERY.md', 'DELIVERY.md', 'final-delivery', 'dist'];
const RELEASE_VERIFY = /(?:^|[/\\])_release-verify(?:[/\\]|$)/i;
const TARBALL = /(?:^|[/\\])[^/\\]+\.tgz$/i;
export function normalizeWorkspacePath(path) {
    return resolve(path);
}
/** Absolute path if `path` is inside `workspace` and is not the workspace root. */
export function resolveInsideWorkspace(path, workspace) {
    const root = normalizeWorkspacePath(workspace);
    const abs = isAbsolute(path) ? resolve(path) : resolve(root, path);
    if (pathsEqual(abs, root))
        return undefined;
    const rel = relative(root, abs);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel))
        return undefined;
    if (rel.split(sep).includes('..'))
        return undefined;
    return abs;
}
export function isTempPattern(path) {
    return RELEASE_NOTES.test(path) || RELEASE_VERIFY.test(path) || TARBALL.test(path);
}
export function isSafeToDelete(resource, workspace) {
    if (resource.temporary !== true || resource.created_by_goal !== true)
        return false;
    if (resource.path === '' || resource.session_id === '' || resource.goal_id === '')
        return false;
    return resolveInsideWorkspace(resource.path, workspace) !== undefined;
}
function record(seen, path, kind, sessionId, goalId, seq, workspace) {
    const abs = resolveInsideWorkspace(path, workspace);
    if (abs === undefined)
        return;
    if (!isTempPattern(abs) && kind !== 'worktree')
        return;
    if (seen.has(abs))
        return;
    seen.set(abs, {
        path: abs,
        kind,
        session_id: sessionId,
        goal_id: goalId,
        created_by_goal: true,
        temporary: true,
        seq,
    });
}
function tarballFromText(text) {
    if (text === undefined)
        return undefined;
    const match = text.match(/(?:^|[\s/\\])([^\s/\\]+\.tgz)\b/i);
    return match?.[1];
}
/** Reconstruct goal-owned temps from structured tool facts / write paths. */
export function discoverTempResources(input) {
    const seen = new Map();
    const workspace = input.workspacePath;
    for (const fact of input.facts.tools) {
        if (!fact.ok)
            continue;
        if (fact.kinds.includes('git_worktree_add') && fact.command !== undefined) {
            const path = parseWorktreeAddPath(fact.command);
            if (path !== undefined)
                record(seen, path, 'worktree', input.sessionId, input.goalId, fact.seq, workspace);
        }
        if (fact.kinds.includes('npm_pack')) {
            const tarball = tarballFromText(fact.resultText) ?? tarballFromText(fact.command);
            if (tarball !== undefined)
                record(seen, tarball, 'file', input.sessionId, input.goalId, fact.seq, workspace);
        }
        if (fact.command !== undefined) {
            for (const path of parseMkdirPaths(fact.command)) {
                if (RELEASE_VERIFY.test(path)) {
                    record(seen, path, 'directory', input.sessionId, input.goalId, fact.seq, workspace);
                }
            }
        }
        if (fact.filePath !== undefined && isTempPattern(fact.filePath)) {
            const kind = RELEASE_VERIFY.test(fact.filePath) && !RELEASE_NOTES.test(fact.filePath) && !TARBALL.test(fact.filePath)
                ? 'directory'
                : 'file';
            record(seen, fact.filePath, kind, input.sessionId, input.goalId, fact.seq, workspace);
        }
    }
    return [...seen.values()];
}
function defaultIo() {
    return {
        exists: (path) => existsSync(path),
        remove: (path) => {
            rmSync(path, { recursive: true, force: true });
        },
        removeWorktree: (path, workspacePath) => {
            spawnSync('git', ['worktree', 'remove', '--force', path], {
                cwd: workspacePath,
                encoding: 'utf8',
                timeout: 15_000,
                windowsHide: true,
            });
        },
        worktreeDirty: (path, workspacePath) => {
            const result = spawnSync('git', ['status', '--porcelain'], {
                cwd: path,
                encoding: 'utf8',
                timeout: 15_000,
                windowsHide: true,
            });
            if (result.error !== undefined && result.error !== null)
                return true;
            if (result.status !== 0) {
                // A worktree git cannot read is exactly the case that must not be
                // force-deleted: fall back to the enclosing repo's own record.
                const fromParent = spawnSync('git', ['-C', workspacePath, 'status', '--porcelain'], {
                    cwd: workspacePath,
                    encoding: 'utf8',
                    timeout: 15_000,
                    windowsHide: true,
                });
                return fromParent.status !== 0;
            }
            return (result.stdout ?? '').trim() !== '';
        },
        artifactsPresent: (path) => {
            // A worktree whose git metadata is gone was already turned into a plain
            // deliverable directory by a previous task; deleting it would destroy the
            // only copy of the result.
            if (!existsSync(join(path, '.git')))
                return true;
            return DELIVERABLE_MARKERS.some((marker) => existsSync(join(path, marker)));
        },
    };
}
/**
 * Delete only resources that pass the fail-safe checks.
 * Cleanup errors become warnings; they do not throw.
 */
export function cleanupTempResources(resources, workspacePath, io = defaultIo()) {
    const removed = [];
    const warnings = [];
    for (const resource of resources) {
        if (!isSafeToDelete(resource, workspacePath))
            continue;
        const abs = resolveInsideWorkspace(resource.path, workspacePath);
        if (abs === undefined)
            continue;
        try {
            if (resource.kind === 'worktree') {
                // A goal's worktree is disposable only while it holds nothing that
                // cannot be regenerated. A defaulted `true` keeps a worktree whose state
                // cannot be read: refusing to delete is always the recoverable choice,
                // while deleting a dirty one destroys work that may be the deliverable.
                const dirty = io.worktreeDirty?.(abs, normalizeWorkspacePath(workspacePath)) ?? true;
                const holdsArtifacts = io.artifactsPresent?.(abs) ?? false;
                if (dirty || holdsArtifacts) {
                    warnings.push(`${abs}: kept because it still holds ${dirty ? 'uncommitted work' : 'a finished deliverable'}; `
                        + 'remove it by hand once its contents are committed or copied out');
                    continue;
                }
                io.removeWorktree?.(abs, normalizeWorkspacePath(workspacePath));
            }
            if (io.exists(abs))
                io.remove(abs);
            removed.push(abs);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            warnings.push(`${abs}: ${message}`);
        }
    }
    return { removed, warnings };
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { foldGoalFacts } from '../../lib/goal-facts.js';
import { normalizePath } from '../../lib/bridge.js';
import { isPathInsideWorkspace } from '../../lib/paths.js';
import {
  cleanupTempResources,
  discoverTempResources,
  isSafeToDelete,
  resolveInsideWorkspace,
} from '../../lib/temp-resources.js';

// The implementation resolves real filesystem paths with node:path, so the
// fixtures must use the platform's native path syntax. Windows-only semantics
// (drive letters, case-insensitive root compare, backslash separators) are
// asserted inside `if (isWin)` blocks; POSIX semantics in the else branch.
// The CI matrix (ubuntu-latest + windows-latest) exercises both branches.
const isWin = process.platform === 'win32';
const WORKSPACE = isWin ? 'D:\\repo' : '/repo';

function owned(path) {
  return {
    path,
    kind: 'directory',
    session_id: 's',
    goal_id: 'g',
    created_by_goal: true,
    temporary: true,
    seq: 1,
  };
}

test('workspace root and paths outside the workspace are not safe to delete', () => {
  assert.equal(isSafeToDelete(owned(WORKSPACE), WORKSPACE), false);
  // Parent escape.
  assert.equal(resolveInsideWorkspace(join(WORKSPACE, '..', 'other'), WORKSPACE), undefined);
  // Sibling / prefix collision: WORKSPACE + "2" must not be treated as inside.
  assert.equal(resolveInsideWorkspace(`${WORKSPACE}2`, WORKSPACE), undefined);
  // Inside paths resolve to themselves and are safe to delete.
  const inside = join(WORKSPACE, 'sub', 'file');
  assert.equal(resolveInsideWorkspace(inside, WORKSPACE), inside);
  assert.equal(isSafeToDelete(owned(inside), WORKSPACE), true);
});

test('approval path containment accepts workspace paths and rejects traversal/siblings', () => {
  assert.equal(isPathInsideWorkspace('src/file.ts', WORKSPACE), true);
  assert.equal(isPathInsideWorkspace(WORKSPACE, WORKSPACE), true);
  assert.equal(isPathInsideWorkspace(join(WORKSPACE, '..', 'outside.ts'), WORKSPACE), false);
  assert.equal(isPathInsideWorkspace(`${WORKSPACE}2${sep}file.ts`, WORKSPACE), false);
});

test('approval path containment rejects a workspace link that resolves outside', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-bridge-path-workspace-'));
  const outside = mkdtempSync(join(tmpdir(), 'dsh-bridge-path-outside-'));
  try {
    const link = join(workspace, 'linked');
    symlinkSync(outside, link, isWin ? 'junction' : 'dir');
    assert.equal(isPathInsideWorkspace(join(link, 'new-file.ts'), workspace), false);
    assert.equal(isPathInsideWorkspace(join(workspace, 'normal', 'new-file.ts'), workspace), true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('resolveInsideWorkspace uses the same compare rule as workspace matching', () => {
  const trailing = `${WORKSPACE}${sep}`;
  assert.equal(resolveInsideWorkspace(WORKSPACE, trailing), undefined);
  assert.equal(resolveInsideWorkspace(trailing, WORKSPACE), undefined);
  assert.equal(normalizePath(trailing), normalizePath(WORKSPACE));
  assert.equal(normalizePath('D:/workspace/sub'), normalizePath('D:\\workspace\\sub'));
  // Traversal that normalizes back to the root is the root, not a child.
  assert.equal(resolveInsideWorkspace(join(WORKSPACE, 'sub', '..'), WORKSPACE), undefined);
  if (isWin) {
    assert.equal(resolveInsideWorkspace(WORKSPACE, WORKSPACE.toLowerCase()), undefined);
    assert.equal(normalizePath(`${WORKSPACE}\\`), normalizePath(WORKSPACE.toLowerCase()));
    assert.equal(normalizePath('D:/repo/path/'), normalizePath('d:\\repo\\path'));
  }
});

test('drive and separator edge cases follow the native platform semantics', () => {
  if (isWin) {
    // A different drive is never inside the workspace.
    assert.equal(resolveInsideWorkspace('C:\\repo', WORKSPACE), undefined);
    // Backslash traversal from inside the workspace.
    assert.equal(resolveInsideWorkspace('D:\\repo\\..\\secret', WORKSPACE), undefined);
    // Sibling that shares the drive-root prefix.
    assert.equal(resolveInsideWorkspace('D:\\repo2', WORKSPACE), undefined);
    // Drive-relative paths resolve against another drive, not the workspace.
    assert.equal(resolveInsideWorkspace('C:foo', WORKSPACE), undefined);
    // UNC paths are never inside a drive workspace.
    assert.equal(resolveInsideWorkspace('\\\\server\\share\\x', WORKSPACE), undefined);
  } else {
    // POSIX is case-sensitive: a differently-cased root is a different directory.
    assert.equal(resolveInsideWorkspace('/REPO', WORKSPACE), undefined);
    // Native forward-slash traversal.
    assert.equal(resolveInsideWorkspace('/repo/../secret', WORKSPACE), undefined);
    // Normalization back to the root is the root, not a child.
    assert.equal(resolveInsideWorkspace('/repo/sub/..', WORKSPACE), undefined);
  }
});

test('discoverTempResources never records paths outside the workspace', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-bridge-discover-outside-'));
  try {
    const events = [
      {
        type: 'tool/call',
        seq: 1,
        data: {
          turn: 1,
          step: 1,
          callId: 'e1',
          name: 'write',
          arguments: JSON.stringify({
            file_path: join(workspace, '..', 'release-notes-v9.9.9.md'),
            content: 'x',
          }),
        },
      },
      {
        type: 'tool/result',
        seq: 2,
        data: { turn: 1, step: 1, message: { source: { callId: 'e1' }, content: [{ isError: false, content: 'ok' }] } },
      },
    ];
    const found = discoverTempResources({
      facts: foldGoalFacts(events),
      sessionId: 's1',
      goalId: 'g1',
      workspacePath: workspace,
    });
    assert.equal(found.length, 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('cleanup never removes paths that escape the workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bridge-cleanup-escape-'));
  const victimPath = join(root, '..', `escape-${process.pid}-${Date.now()}.md`);
  writeFileSync(victimPath, 'keep');
  try {
    const resources = [
      owned(join(root, '..', 'release-notes-v9.9.9.md')),
      { ...owned(victimPath), kind: 'file' },
    ];
    const result = cleanupTempResources(resources, root);
    assert.equal(result.removed.length, 0);
    assert.equal(existsSync(victimPath), true);
  } finally {
    rmSync(victimPath, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup with a trailing-separator workspace root still refuses the root', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bridge-cleanup-root-'));
  try {
    const result = cleanupTempResources([owned(root)], `${root}${sep}`);
    assert.equal(result.removed.length, 0);
    assert.equal(existsSync(root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Test F — cleanup removes goal-owned temps and keeps unrelated files', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bridge-cleanup-'));
  try {
    const verify = join(root, '_release-verify', 'v020');
    mkdirSync(verify, { recursive: true });
    writeFileSync(join(verify, 'pack.txt'), 'x');
    const notes = join(root, 'release-notes-v0.2.0.md');
    writeFileSync(notes, 'notes');
    const user = join(root, 'user-notes.md');
    writeFileSync(user, 'keep me');

    const resources = [
      {
        path: join(root, '_release-verify'),
        kind: 'directory',
        session_id: 's1',
        goal_id: 'g1',
        created_by_goal: true,
        temporary: true,
        seq: 1,
      },
      {
        path: notes,
        kind: 'file',
        session_id: 's1',
        goal_id: 'g1',
        created_by_goal: true,
        temporary: true,
        seq: 2,
      },
    ];
    const result = cleanupTempResources(resources, root);
    assert.equal(existsSync(join(root, '_release-verify')), false);
    assert.equal(existsSync(notes), false);
    assert.equal(existsSync(user), true);
    assert.equal(result.warnings.length, 0);
    assert.ok(result.removed.length >= 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discoverTempResources only records worktree / release-verify / notes / tarball', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-bridge-discover-'));
  try {
    const events = [
      {
        type: 'tool/call',
        seq: 1,
        data: {
          turn: 1,
          step: 1,
          callId: 'w1',
          name: 'bash',
          arguments: JSON.stringify({ command: `git worktree add ${join(workspace, '_release-verify', 'v020')} HEAD` }),
        },
      },
      {
        type: 'tool/result',
        seq: 2,
        data: { turn: 1, step: 1, message: { source: { callId: 'w1' }, content: [{ isError: false, content: 'ok' }] } },
      },
      {
        type: 'tool/call',
        seq: 3,
        data: {
          turn: 1,
          step: 1,
          callId: 'n1',
          name: 'write',
          arguments: JSON.stringify({ file_path: join(workspace, 'release-notes-v0.2.0.md'), content: 'x' }),
        },
      },
      {
        type: 'tool/result',
        seq: 4,
        data: { turn: 1, step: 1, message: { source: { callId: 'n1' }, content: [{ isError: false, content: 'ok' }] } },
      },
      {
        type: 'tool/call',
        seq: 5,
        data: {
          turn: 1,
          step: 1,
          callId: 'u1',
          name: 'write',
          arguments: JSON.stringify({ file_path: join(workspace, 'README.md'), content: 'nope' }),
        },
      },
      {
        type: 'tool/result',
        seq: 6,
        data: { turn: 1, step: 1, message: { source: { callId: 'u1' }, content: [{ isError: false, content: 'ok' }] } },
      },
    ];
    const found = discoverTempResources({
      facts: foldGoalFacts(events),
      sessionId: 's1',
      goalId: 'g1',
      workspacePath: workspace,
    });
    assert.ok(found.some((item) => item.kind === 'worktree'));
    assert.ok(found.some((item) => /release-notes-v0\.2\.0\.md$/i.test(item.path)));
    assert.equal(found.some((item) => /README\.md$/i.test(item.path)), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

// ── cleanup must never force-delete a worktree that still holds work ────────

/** A worktree-owned temp resource inside the workspace. */
function ownedWorktree(path) {
  return { ...owned(path), kind: 'worktree' };
}

/** An io stand-in that records every removal instead of touching the disk. */
function recordingIo(overrides = {}) {
  const removed = [];
  const worktrees = [];
  return {
    removed,
    worktrees,
    io: {
      exists: (path) => overrides.exists?.(path) ?? true,
      remove: (path) => {
        removed.push(path);
        overrides.remove?.(path);
      },
      removeWorktree: (path) => {
        worktrees.push(path);
        overrides.removeWorktree?.(path);
      },
      worktreeDirty: (path) => overrides.worktreeDirty?.(path) ?? false,
      artifactsPresent: (path) => overrides.artifactsPresent?.(path) ?? false,
    },
  };
}

test('cleanup keeps a worktree that still has uncommitted work', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bridge-keeptree-'));
  const tree = join(root, 'task-worktree');
  mkdirSync(tree, { recursive: true });
  writeFileSync(join(tree, 'work.txt'), 'uncommitted\n');
  try {
    const { io, removed, worktrees } = recordingIo({ worktreeDirty: () => true });
    const result = cleanupTempResources([ownedWorktree(tree)], root, io);

    assert.deepEqual(worktrees, [], 'a dirty worktree must not be force-removed');
    assert.deepEqual(removed, [], 'and its directory must not be deleted either');
    assert.equal(result.removed.length, 0);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /uncommitted work/);
    assert.equal(existsSync(tree), true, 'the work is still on disk');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup keeps a worktree that holds a finished deliverable', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bridge-keepdeliv-'));
  const tree = join(root, 'task-worktree');
  mkdirSync(tree, { recursive: true });
  writeFileSync(join(tree, 'DELIVERY.md'), '# delivery\n');
  try {
    const { io, removed, worktrees } = recordingIo({ artifactsPresent: () => true });
    const result = cleanupTempResources([ownedWorktree(tree)], root, io);

    assert.deepEqual(worktrees, []);
    assert.deepEqual(removed, []);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /finished deliverable/);
    assert.equal(existsSync(tree), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup still removes a worktree that is clean and holds nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bridge-droptree-'));
  const tree = join(root, 'task-worktree');
  mkdirSync(tree, { recursive: true });
  try {
    const { io, removed, worktrees } = recordingIo();
    const result = cleanupTempResources([ownedWorktree(tree)], root, io);

    assert.deepEqual(worktrees, [tree], 'a clean, artifact-free worktree is still cleaned up');
    assert.deepEqual(removed, [tree]);
    assert.deepEqual(result.warnings, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup treats an unreadable worktree state as dirty rather than deletable', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bridge-unknownstate-'));
  const tree = join(root, 'task-worktree');
  mkdirSync(tree, { recursive: true });
  try {
    // No worktreeDirty hook at all: the implementation must default to keeping.
    const removed = [];
    const worktrees = [];
    const result = cleanupTempResources([ownedWorktree(tree)], root, {
      exists: () => true,
      remove: (path) => removed.push(path),
      removeWorktree: (path) => worktrees.push(path),
    });

    assert.deepEqual(worktrees, []);
    assert.deepEqual(removed, []);
    assert.match(result.warnings[0], /uncommitted work/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup default io treats a directory without git metadata as a deliverable', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bridge-nogit-'));
  const tree = join(root, 'plain-delivery');
  mkdirSync(tree, { recursive: true });
  writeFileSync(join(tree, 'result.txt'), 'the only copy\n');
  try {
    // No io injection: exercises the real default `artifactsPresent`.
    const result = cleanupTempResources([ownedWorktree(tree)], root);

    assert.deepEqual(result.removed, []);
    assert.equal(result.warnings.length, 1);
    assert.equal(existsSync(join(tree, 'result.txt')), true, 'the only copy survives');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

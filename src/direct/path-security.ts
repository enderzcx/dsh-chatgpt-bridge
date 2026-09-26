/**
 * Direct-surface path security.
 *
 * Every path an MCP caller supplies goes through resolveExistingTarget() (for
 * reads) or resolveWritableTarget() (for writes). Both:
 *   - require an absolute path — a caller cannot opt into a root by naming it;
 *   - canonicalize through realpath so `..`, symlinks and macOS `/tmp` →
 *     `/private/tmp` aliases cannot escape containment;
 *   - refuse credential-shaped segments/basenames before touching the disk;
 *   - for writes, verify the nearest existing ancestor is a real directory
 *     inside a writable root and refuse to follow a symlink by default.
 *
 * Containment is decided against realpath() of the root, which is computed once
 * at policy-resolve time, so a root that is itself a symlink still works.
 */
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { assertNotCredentialFile, scrubPathForDisplay } from './secrets.js';
import { DirectOpsError, type DirectOpsPolicy, type DirectOpsRoot } from './types.js';

export interface ResolvedTarget {
  /** Canonical absolute path (realpath of the target, or of a writable target's parent joined with the basename). */
  canonical: string;
  /** The trusted root that authorized this path. */
  root: DirectOpsRoot;
  /** True when the caller path names an existing filesystem entry. */
  exists: boolean;
  /** True when the canonical path is itself a symlink. */
  isSymlink: boolean;
}

function isContained(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/** Deny configured segments, matched on whole path segments. */
function assertNoDeniedSegment(canonicalPath: string, policy: DirectOpsPolicy): void {
  const segments = segmentsOf(canonicalPath);
  for (const denied of policy.deniedNames) {
    const needle = denied.toLowerCase();
    for (const segment of segments) {
      const lower = segment.toLowerCase();
      if (lower === needle || lower.startsWith(`${needle}/`)) {
        throw new DirectOpsError('PATH_DENIED', `path contains a denied segment "${needle}"`, {
          path: scrubPathForDisplay(canonicalPath),
        });
      }
    }
  }
}

function assertAbsolute(input: string): void {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new DirectOpsError('INVALID_PATH', 'path must be a non-empty absolute path');
  }
  if (!isAbsolute(input)) {
    throw new DirectOpsError(
      'INVALID_PATH',
      'path must be absolute; relative paths are resolved against an implicit cwd and are not accepted',
      { path: scrubPathForDisplay(input) },
    );
  }
}

/** Nearest existing ancestor, used when the target itself does not exist yet. */
function nearestExisting(path: string): string {
  let current = path;
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/**
 * The INNERMOST root that contains the path wins. Without this, a writable parent
 * root would swallow a read-only child root and grant writes the host explicitly
 * withheld.
 */
function pickRoot(canonical: string, roots: DirectOpsRoot[]): DirectOpsRoot | undefined {
  let best: DirectOpsRoot | undefined;
  for (const root of roots) {
    if (isContained(canonical, root.real) && (best === undefined || root.real.length > best.real.length)) {
      best = root;
    }
  }
  return best;
}

/**
 * Refuse the policy/control file for reads and writes alike: it decides what the
 * direct surface may do, so a tool that could read or rewrite it would be able to
 * widen its own permissions. Protection covers the file itself and, when it sits
 * inside a writable root, its directory.
 */
function assertNotProtected(canonicalPath: string, policy: DirectOpsPolicy, verb: string): void {
  for (const protectedPath of policy.protectedPaths) {
    if (canonicalPath === protectedPath || isContained(canonicalPath, protectedPath)) {
      throw new DirectOpsError(
        'PATH_DENIED',
        `${verb} is refused: this path is the direct-operations control configuration, which the direct surface `
          + 'never reads or writes because it governs the surface itself',
        { path: scrubPathForDisplay(canonicalPath) },
      );
    }
  }
}

/**
 * Resolve a path that must already exist.
 *
 * `options.skipProtection` is used only for a command's cwd: a cwd inside the
 * policy file's directory is legitimate (the sandbox still denies the file and
 * the directory for read and write), whereas the file tools must never touch
 * those paths at all.
 */
export function resolveExistingTarget(
  input: string,
  policy: DirectOpsPolicy,
  options: { skipProtection?: boolean } = {},
): ResolvedTarget {
  assertAbsolute(input);
  let lstat;
  const absolute = resolve(input);
  try {
    lstat = lstatSync(absolute);
  } catch {
    throw new DirectOpsError('NOT_FOUND', 'path does not exist', { path: scrubPathForDisplay(absolute) });
  }
  let canonical: string;
  try {
    canonical = realpathSync.native(absolute);
  } catch {
    throw new DirectOpsError('INVALID_PATH', 'path could not be canonicalized', {
      path: scrubPathForDisplay(absolute),
    });
  }
  assertNoDeniedSegment(canonical, policy);
  assertNotCredentialFile(canonical, policy.deniedBasenames);
  if (options.skipProtection !== true) assertNotProtected(canonical, policy, 'reading this path');
  const root = pickRoot(canonical, policy.roots);
  if (root === undefined) {
    throw new DirectOpsError(
      'PATH_OUTSIDE_ROOTS',
      'path is outside every trusted root of this bridge (roots are server-side configuration, not caller arguments)',
      { path: scrubPathForDisplay(canonical), roots: policy.roots.map((item) => item.label) },
    );
  }
  return { canonical, root, exists: true, isSymlink: lstat.isSymbolicLink() };
}

/** Resolve a path that may be created or replaced. */
export function resolveWritableTarget(input: string, policy: DirectOpsPolicy): ResolvedTarget {
  assertAbsolute(input);
  const absolute = resolve(input);
  const existed = existsSync(absolute);
  let canonical: string;
  let isSymlink = false;

  if (existed) {
    try {
      const lstat = lstatSync(absolute);
      isSymlink = lstat.isSymbolicLink();
    } catch {
      // Raced away; fall through to the not-exists branch below on realpath failure.
    }
    try {
      canonical = realpathSync.native(absolute);
      if (!isSymlink) {
        const info = statSync(canonical);
        if (!info.isFile()) {
          throw new DirectOpsError('NOT_A_FILE', 'target exists and is not a regular file', {
            path: scrubPathForDisplay(canonical),
          });
        }
      }
    } catch (error) {
      if (error instanceof DirectOpsError) throw error;
      throw new DirectOpsError('INVALID_PATH', 'target path could not be canonicalized', {
        path: scrubPathForDisplay(absolute),
      });
    }
    assertNoDeniedSegment(canonical, policy);
    assertNotCredentialFile(canonical, policy.deniedBasenames);
    assertNotProtected(canonical, policy, 'writing this path');
    const root = pickRoot(canonical, policy.roots);
    if (root === undefined || !root.writable) {
      throw new DirectOpsError(
        'PATH_OUTSIDE_ROOTS',
        root === undefined
          ? 'path is outside every trusted root of this bridge'
          : 'that trusted root is mounted read-only',
        { path: scrubPathForDisplay(canonical), roots: policy.roots.map((item) => item.label) },
      );
    }
    return { canonical, root, exists: true, isSymlink };
  }

  const parent = nearestExisting(dirname(absolute));
  let realParent: string;
  try {
    realParent = realpathSync.native(parent);
  } catch {
    throw new DirectOpsError('INVALID_PATH', 'parent directory could not be canonicalized', {
      path: scrubPathForDisplay(parent),
    });
  }
  let parentIsDir = false;
  try {
    parentIsDir = statSync(realParent).isDirectory();
  } catch {
    parentIsDir = false;
  }
  if (!parentIsDir) {
    throw new DirectOpsError('INVALID_PATH', 'parent path is not a directory', {
      path: scrubPathForDisplay(realParent),
    });
  }
  const suffix = relative(parent, absolute);
  if (suffix.startsWith('..') || isAbsolute(suffix)) {
    throw new DirectOpsError('INVALID_PATH', 'target escapes its nearest existing ancestor', {
      path: scrubPathForDisplay(absolute),
    });
  }
  canonical = suffix === '' ? realParent : resolve(realParent, suffix);
  assertNoDeniedSegment(canonical, policy);
  assertNotCredentialFile(canonical, policy.deniedBasenames);
  assertNotProtected(canonical, policy, 'creating this path');
  const root = pickRoot(canonical, policy.roots);
  if (root === undefined || !root.writable) {
    throw new DirectOpsError(
      'PATH_OUTSIDE_ROOTS',
      root === undefined
        ? 'path is outside every trusted root of this bridge'
        : 'that trusted root is mounted read-only',
      { path: scrubPathForDisplay(canonical), roots: policy.roots.map((item) => item.label) },
    );
  }
  return { canonical, root, exists: false, isSymlink: false };
}

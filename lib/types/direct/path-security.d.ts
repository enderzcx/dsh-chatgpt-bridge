import { type DirectOpsPolicy, type DirectOpsRoot } from './types.js';
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
/**
 * Resolve a path that must already exist.
 *
 * `options.skipProtection` is used only for a command's cwd: a cwd inside the
 * policy file's directory is legitimate (the sandbox still denies the file and
 * the directory for read and write), whereas the file tools must never touch
 * those paths at all.
 */
export declare function resolveExistingTarget(input: string, policy: DirectOpsPolicy, options?: {
    skipProtection?: boolean;
}): ResolvedTarget;
/** Resolve a path that may be created or replaced. */
export declare function resolveWritableTarget(input: string, policy: DirectOpsPolicy): ResolvedTarget;

/**
 * Direct-operation surface: types.
 *
 * "Direct" means ChatGPT calls these MCP tools straight into local file and
 * process operations on the DSH host. No agent session is created, no model
 * turn is consumed, no DSH tool is invoked. Authorization comes from the
 * server-side trusted policy (config resolved at plugin load / policy reload),
 * never from arguments the caller supplies.
 */
export type SandboxAvailability = 'available' | 'unavailable' | 'not-applicable';
/** One trusted read/write root. Paths are canonicalized at resolve time. */
export interface DirectOpsRoot {
    /** Absolute path prefix as configured (may be a symlink; realpath is used). */
    path: string;
    /** Canonical path actually enforced. */
    real: string;
    /** Exact path or path prefix label used in tool output. */
    label: string;
    /** Writes allowed under this root. */
    writable: boolean;
}
export interface DirectOpsLimits {
    /** Max bytes returned by one read before truncation. */
    readMaxBytes: number;
    /** Default page size in lines for ranges mode. */
    readMaxLines: number;
    /** Hard cap on how far a single read may page into a file (bytes from offset 0). */
    readMaxWindowBytes: number;
    /** Max bytes accepted by one write/edit payload. */
    writeMaxBytes: number;
    /** Max stdout bytes captured per stream. */
    execMaxOutputBytes: number;
    /** Default exec timeout in milliseconds. */
    execTimeoutMs: number;
    /** Hard cap on exec timeout in milliseconds. */
    execMaxTimeoutMs: number;
}
export interface DirectOpsExecPolicy {
    enabled: boolean;
    /** Allowlist of executable names resolved on PATH. */
    allowedCommands: string[];
    /** Trusted roots a command's cwd must stay inside. A cwd never grants writes. */
    cwdRoots: string[];
    /** Roots the child may WRITE. Empty means the sandbox grants no write path. */
    writableRoots: string[];
    /** 'deny' blocks network syscalls via the OS sandbox; 'allow' does not. */
    network: 'deny' | 'allow';
    /** 'roots' confines reads to trusted roots and writes to writableRoots. */
    filesystem: 'roots' | 'inherit';
    /** 'required' refuses to run at all when no OS sandbox is available. */
    sandbox: 'required' | 'preferred';
    /** Keys copied from process.env; anything else is dropped. */
    envPassthrough: string[];
    /** Extra PATH entries for command resolution. */
    pathEntries: string[];
}
export interface DirectOpsPolicy {
    enabled: boolean;
    writesEnabled: boolean;
    roots: DirectOpsRoot[];
    limits: DirectOpsLimits;
    exec: DirectOpsExecPolicy;
    /** True when `dsh_operator_reload_policy` re-reads policy from disk. */
    policyReloadable: boolean;
    /** Trusted policy file path, reported for observability only. */
    policyFile?: string;
    /** Raw configured root strings, before canonicalization. */
    configuredRoots: string[];
    /** Denied path/dir names (lowercase), enforced for every operation. */
    deniedNames: string[];
    /** Denied credential-shaped basenames, enforced for every operation. */
    deniedBasenames: RegExp[];
    /** Canonical path of the policy file, when one is configured. */
    policyFileReal?: string;
    /**
     * Paths the direct surface must never read or write through its file tools and
     * must deny inside the OS sandbox: the policy file itself, plus its directory
     * when the file sits inside a writable root.
     */
    protectedPaths: string[];
}
export interface DirectOpsRootView {
    label: string;
    path: string;
    writable: boolean;
}
export interface DirectOpsPolicyView {
    enabled: boolean;
    writes_enabled: boolean;
    exec_enabled: boolean;
    exec_sandbox: DirectOpsExecPolicy['sandbox'];
    sandbox_available: boolean;
    sandbox_kind: string;
    network: 'deny' | 'allow';
    filesystem: 'roots' | 'inherit';
    roots: DirectOpsRootView[];
    allowed_commands: string[];
    limits: DirectOpsLimits;
    policy_file?: string;
    /** Explicit, non-negotiable boundaries worth stating to the caller. */
    notes: string[];
}
/** Stable error codes for the direct surface. */
export type DirectOpsErrorCode = 'DIRECT_OPS_DISABLED' | 'WRITE_DISABLED' | 'EXEC_DISABLED' | 'SANDBOX_UNAVAILABLE' | 'INVALID_PATH' | 'PATH_OUTSIDE_ROOTS'
/** The path resolved to a different file than when the operation started. */
 | 'PATH_REDIRECTED' | 'PATH_DENIED' | 'NOT_A_FILE' | 'NOT_FOUND'
/** The OS refused the read (permissions), as opposed to the path being absent. */
 | 'NOT_READABLE' | 'IS_BINARY' | 'FILE_TOO_LARGE' | 'READ_REQUIRED' | 'VERSION_CONFLICT' | 'WRITE_CONFLICT'
/** The commit happened, but the post-commit read-back did not match what we wrote. */
 | 'POST_COMMIT_CONFLICT' | 'TOO_MANY_EDITS' | 'EDIT_NOT_FOUND' | 'EDIT_AMBIGUOUS' | 'LOCK_BUSY' | 'COMMAND_NOT_ALLOWED' | 'INVALID_ARGUMENT' | 'SPAWN_FAILED' | 'INTERNAL';
export declare class DirectOpsError extends Error {
    readonly code: DirectOpsErrorCode;
    readonly details?: Record<string, unknown>;
    constructor(code: DirectOpsErrorCode, message: string, details?: Record<string, unknown>);
}

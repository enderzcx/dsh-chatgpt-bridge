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
    /**
     * Which local execution backend runs the argv vector.
     *
     * `sandbox-exec` (default) runs the command through the existing macOS
     * Seatbelt plan. `codex-app-server` asks a local `codex app-server` to run it
     * through its own OS sandbox; that path never creates a thread, turn, or
     * model call. The chosen backend is reported in every result.
     */
    backend: 'sandbox-exec' | 'codex-app-server';
    /**
     * Executable used by the `codex-app-server` backend. An absolute path is
     * required so the caller can never choose the binary; the empty string means
     * unset, and the bridge then refuses rather than guessing from PATH.
     */
    codexBin: string;
    /** App-server argv inserted before `app-server` (e.g. `-c key=value`). */
    codexArgs: string[];
    /**
     * Isolated codex state directory, passed as CODEX_HOME.
     *
     * Measured: without this the child loads the user's ~/.codex/config.toml (it
     * reported codexHome=<user home>/.codex), so the bridge would silently inherit
     * whatever the user configured there. With it set to a bridge-owned directory
     * the child reads that instead and the user's global config is untouched and
     * unread. The empty string means unset.
     */
    codexHome: string;
    /**
     * Administrator-only full-access mode.
     *
     * When true, this surface stops confining the child: any allowlisted-name
     * executable may be named (the allowlist is bypassed), the working directory may
     * be any absolute path, and codex is given `dangerFullAccess` so there is no OS
     * sandbox for reads, writes, temp directories or the network.
     *
     * It can ONLY be turned on by trusted server-side configuration. No tool
     * argument can reach it. When it is on, results and `dsh_operator_roots` say so
     * explicitly rather than continuing to claim a sandbox was applied.
     */
    fullAccess: boolean;
    /** Bound on stored output per async run, per stream. */
    asyncMaxOutputBytes: number;
    /** Bound on concurrently live async runs. */
    asyncMaxRuns: number;
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
    /** Which local backend would run a command. */
    exec_backend: DirectOpsExecPolicy['backend'];
    /**
     * Whether an OS-level sandbox can actually confine a command right now, for
     * the backend in use. For `codex-app-server` this means a configured codex
     * executable, because codex owns the confinement.
     */
    sandbox_available: boolean;
    sandbox_kind: string;
    /** Async runs need the codex backend; false means dsh_start_command refuses. */
    async_runs: boolean;
    /**
     * Command write scope, independent of the file tools' roots.
     * `unconfined` under administrator full access.
     */
    command_writable_roots: string[] | 'unconfined';
    /**
     * EFFECTIVE command-name policy: `any-on-path` when any bare executable name is
     * accepted, `allowlist` when `allowed_commands` applies.
     */
    command_policy: 'any-on-path' | 'allowlist';
    /** The configured allowlist, reported separately because it may not be in force. */
    configured_allowed_commands: string[];
    /** The configured cwd roots, reported separately because they may not be in force. */
    configured_cwd_roots: string[];
    /**
     * EFFECTIVE sandbox demand. Under full access this is `none` even though the
     * configured `exec.sandbox` may say `required`.
     */
    exec_sandbox_effective: DirectOpsExecPolicy['sandbox'] | 'none';
    /** EFFECTIVE network reach; `unconfined` when no sandbox is applied. */
    network: 'deny' | 'allow' | 'unconfined';
    /** EFFECTIVE filesystem scope; `unconfined` when no sandbox is applied. */
    filesystem: 'roots' | 'inherit' | 'unconfined';
    /** Present only under full access: the configured values that are NOT in force. */
    configured_network?: 'deny' | 'allow';
    configured_filesystem?: 'roots' | 'inherit';
    /**
     * Administrator full-access mode. When true there is NO OS sandbox: reads,
     * writes, cwd, temp directories and the network are unconfined, and `roots`
     * must not be read as a boundary.
     */
    full_access: boolean;
    /**
     * Bounded, secret-free call-receipt diagnostics.
     *
     * In-memory for this process only: a restart empties it, which is why the
     * coverage block states the window and the restart boundary. An absent record
     * means "not observed within this window", never "the caller did not send it".
     */
    diagnostics: {
        coverage: Record<string, unknown>;
        /** Fingerprint of the real tools/list JSON this server advertises. */
        tool_surface?: Record<string, unknown>;
        /** Most recent receipts, bounded; contains no arguments or error text. */
        recent: Record<string, unknown>[];
    };
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
 | 'POST_COMMIT_CONFLICT' | 'TOO_MANY_EDITS' | 'EDIT_NOT_FOUND' | 'EDIT_AMBIGUOUS' | 'LOCK_BUSY' | 'COMMAND_NOT_ALLOWED' | 'INVALID_ARGUMENT' | 'SPAWN_FAILED'
/** exec.backend is codex-app-server but no codex executable was configured. */
 | 'CODEX_BIN_UNCONFIGURED'
/** The configured policy has no faithful codex sandbox equivalent. */
 | 'CODEX_POLICY_UNSUPPORTED'
/** The app server could not be started, answered badly, or died. */
 | 'CODEX_SPAWN_FAILED' | 'CODEX_RPC_ERROR' | 'CODEX_REQUEST_TIMEOUT' | 'CODEX_WRITE_FAILED' | 'CODEX_BAD_RESULT' | 'CODEX_NOT_RUNNING' | 'CODEX_EXITED' | 'CODEX_CLOSED' | 'CODEX_ALREADY_STARTED' | 'CODEX_EMPTY_COMMAND'
/** This client may only use the command/exec surface. */
 | 'CODEX_METHOD_NOT_ALLOWED' | 'CODEX_EXEC_FAILED' | 'RUN_NOT_FOUND' | 'RUN_LIMIT_REACHED' | 'RUN_TERMINATE_FAILED'
/** Async runs need the codex backend; the sandbox path cannot serve them. */
 | 'ASYNC_UNSUPPORTED_BACKEND' | 'INTERNAL';
export declare class DirectOpsError extends Error {
    readonly code: DirectOpsErrorCode;
    readonly details?: Record<string, unknown>;
    constructor(code: DirectOpsErrorCode, message: string, details?: Record<string, unknown>);
}

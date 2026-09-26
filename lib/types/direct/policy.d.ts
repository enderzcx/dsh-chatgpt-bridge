import { type DirectOpsExecPolicy, type DirectOpsLimits, type DirectOpsPolicy } from './types.js';
/** Raw host-supplied config, validated structurally before it becomes a policy. */
export interface DirectOpsConfigInput {
    enabled?: boolean;
    allowWrites?: boolean;
    roots?: string[];
    writableRoots?: string[];
    policyFile?: string;
    deniedNames?: string[];
    limits?: Partial<DirectOpsLimits>;
    exec?: {
        enabled?: boolean;
        allowedCommands?: string[];
        cwdRoots?: string[];
        /** Paths the child may WRITE. Independent of cwd; empty means no writes. */
        writableRoots?: string[];
        network?: 'deny' | 'allow';
        filesystem?: 'roots' | 'inherit';
        sandbox?: 'required' | 'preferred';
        envPassthrough?: string[];
        pathEntries?: string[];
        /** Local execution backend; see {@link DirectOpsExecPolicy.backend}. */
        backend?: 'sandbox-exec' | 'codex-app-server';
        /** Absolute path to the codex executable for the app-server backend. */
        codexBin?: string;
        codexArgs?: string[];
        /** Isolated CODEX_HOME for the app-server child; see DirectOpsExecPolicy. */
        codexHome?: string;
        /**
         * Administrator-only full access; see {@link DirectOpsExecPolicy.fullAccess}.
         * Defaults to false, and only this trusted config can enable it.
         */
        fullAccess?: boolean;
        asyncMaxOutputBytes?: number;
        asyncMaxRuns?: number;
    };
}
export declare const DEFAULT_DIRECT_LIMITS: DirectOpsLimits;
export declare const DEFAULT_EXEC_POLICY: DirectOpsExecPolicy;
/**
 * Report whether an OS-level sandbox is available. Cached briefly because it
 * stats a binary on every exec call, but never cached as `true` when missing.
 */
export declare function sandboxExecAvailable(now?: number): boolean;
export declare function sandboxKind(): string;
/** Read and JSON-parse the trusted policy file, if configured. */
export declare function readPolicyFile(path: string): DirectOpsConfigInput;
/**
 * Resolve the effective direct-ops policy. `fileConfig` wins over `rowConfig`
 * so the host can keep sensitive roots out of the plugin row.
 */
export declare function resolveDirectOpsPolicy(row: DirectOpsConfigInput, explicitFileConfig?: DirectOpsConfigInput): DirectOpsPolicy;
/** Resolve a command name against the allowlist, returning the absolute path to run. */
export declare function resolveAllowedCommand(cmd: string, policy: DirectOpsPolicy): {
    path: string;
    usedPath: boolean;
};
/** True when `path` is inside (or equal to) one of the user data trees. */
export declare function isUnderUserDataTree(path: string): boolean;
/**
 * Build the sandbox-exec profile for one exec call.
 *
 * HONEST SCOPE — this is a denylist of user-data trees plus a write allow-list,
 * NOT a full read sandbox:
 *   - data reads are denied for USER_DATA_DENY_TREES and re-allowed for the
 *     trusted roots (plus the binary's own path), which stops a command from
 *     reading `~/.ssh`, other projects, or a sibling of a root;
 *   - everything else on the machine outside those trees stays readable;
 *   - writes are allowed only for `writableRoots`, never `cwd` by default.
 * A default-deny read profile (deny file-read* then allow subpaths) is NOT
 * equivalent: it aborts every child because the dynamic loader reads the volume
 * root, so it is not used here. Complete path isolation is deferred, which is
 * why `exec` remains disabled by default and is documented as a prototype.
 *
 * The profile uses canonical (realpath) paths because the sandbox matches real
 * paths — on macOS `/tmp` is `/private/tmp`.
 */
export declare function buildSandboxProfile(options: {
    policy: DirectOpsPolicy;
    cwd: string;
    binary: string;
    readableRoots: string[];
    writableRoots: string[];
    deniedReadPaths: string[];
}): string;
/** True when at least one sandbox layer is actually requested. */
export declare function sandboxLayerRequested(policy: DirectOpsPolicy): boolean;
/** Verify a sandbox is usable, or fail closed when it is required. */
export declare function assertSandboxAvailable(policy: DirectOpsPolicy): boolean;
/** Cheap self-description used by dsh_operator_roots. */
export declare function execFileVersion(): string;

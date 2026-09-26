import { sandboxExecAvailable } from './policy.js';
import { type DirectOpsPolicy } from './types.js';
export interface ExecInput {
    cmd: string;
    args?: string[];
    cwd?: string;
    timeout_ms?: number;
    max_output_bytes?: number;
    env?: Record<string, string>;
}
export interface ExecResult {
    cmd: string;
    argv: string[];
    cwd: string;
    resolved_binary: string;
    exit_code: number | null;
    signal: string | null;
    timed_out: boolean;
    duration_ms: number;
    stdout: string;
    stderr: string;
    stdout_bytes: number;
    stderr_bytes: number;
    stdout_truncated: boolean;
    stderr_truncated: boolean;
    max_output_bytes: number;
    /** Which local backend actually ran the command. */
    backend: 'sandbox-exec' | 'codex-app-server';
    sandbox: {
        kind: string;
        /** EFFECTIVE reach; `unconfined` whenever no sandbox is applied. */
        network: 'deny' | 'allow' | 'unconfined';
        /** EFFECTIVE scope; `unconfined` whenever no sandbox is applied. */
        filesystem: 'roots' | 'inherit' | 'unconfined';
        applied: boolean;
        /**
         * Whether the cwd is itself writable. False under any sandboxed policy (a
         * cwd is a location, not a grant); true only in administrator full access.
         */
        cwd_grants_writes: boolean;
        /** Whether the cwd was confined to the configured cwd roots. */
        cwd_restricted?: boolean;
        /** Whether commands were limited to the allowlist. */
        command_restricted?: boolean;
        /** Present only when unconfined: the configured values NOT in force. */
        configured_network?: 'deny' | 'allow';
        configured_filesystem?: 'roots' | 'inherit';
        readable_roots?: string[];
        /** Configured write roots, or `unconfined` when there is no boundary. */
        writable_roots?: string[] | 'unconfined';
        codex_policy?: string;
        read_scope?: string;
        write_scope?: string;
        note?: string;
        timeout_evidence?: string;
    };
    env_keys: string[];
}
export declare function buildChildEnv(policy: DirectOpsPolicy, overrides?: Record<string, string>): Record<string, string>;
/** Whether `path` is one of `roots` or sits beneath one. */
export declare function withinAnyRoot(path: string, roots: readonly string[]): boolean;
export declare function resolveCwd(input: string | undefined, policy: DirectOpsPolicy): string;
/**
 * Build the ONE effective sandbox envelope used by every command result.
 *
 * `applied` alone decides whether the configured boundary is in force. When no
 * OS sandbox confines the child, network and filesystem are reported as
 * `unconfined` and the configured values move to `configured_*`, so a result can
 * never say `network: "deny"` next to a child that was in fact online.
 */
export declare function effectiveSandboxEnvelope(input: {
    kind: string;
    applied: boolean;
    fullAccess: boolean;
    configured: {
        network: 'deny' | 'allow';
        filesystem: 'roots' | 'inherit';
        writableRoots: string[];
    };
    extra?: Record<string, unknown>;
}): ExecResult['sandbox'];
export declare function runCommand(input: ExecInput, policy: DirectOpsPolicy): Promise<ExecResult>;
export { sandboxExecAvailable };

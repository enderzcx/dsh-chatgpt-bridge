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
    sandbox: {
        kind: string;
        network: 'deny' | 'allow';
        /** 'roots' means reads AND writes are confined by the OS sandbox. */
        filesystem: 'roots' | 'inherit';
        applied: boolean;
        /** Cwd is reported so a caller can see it is a location, not a boundary. */
        cwd_grants_writes: false;
        readable_roots?: string[];
        writable_roots?: string[];
    };
    env_keys: string[];
}
export declare function runCommand(input: ExecInput, policy: DirectOpsPolicy): Promise<ExecResult>;
export { sandboxExecAvailable };

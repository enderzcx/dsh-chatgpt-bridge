import { type RunView } from './exec-runs.js';
import { type DirectOpsPolicy } from './types.js';
export interface StartRunInput {
    cmd: string;
    args?: string[];
    cwd?: string;
    timeout_ms?: number;
    max_output_bytes?: number;
    env?: Record<string, string>;
}
/**
 * Start one allowlisted command as an async run and return immediately.
 *
 * Only the codex backend supports async runs: the Seatbelt path has no way to
 * stream or terminate a child after the MCP call returns, so asking for it there
 * is an explicit refusal rather than a silent downgrade to synchronous work.
 */
export declare function startCommand(input: StartRunInput, policy: DirectOpsPolicy): Promise<RunView>;
/** Read one run's output, optionally only what arrived after `since_seq`. */
export declare function readRun(runId: string, sinceSeq: number | undefined, policy: DirectOpsPolicy): RunView;
/**
 * Terminate one async run and report only what was confirmed.
 *
 * The stop request goes over the run's own connection (the app server scopes a
 * `processId` to its connection). The run is then waited on: `terminated` is
 * true only once the process has actually exited. If the stop cannot be
 * confirmed, the run keeps its `running` status so the concurrency slot is not
 * handed out while a process is still alive, and the caller is told the
 * confirmation is outstanding.
 */
export declare function terminateRun(runId: string, policy: DirectOpsPolicy): Promise<RunView & {
    terminated: boolean;
    confirmation: 'exited' | 'not_running' | 'unconfirmed';
}>;
/** Whether this policy can serve async runs at all, for policy self-description. */
export declare function asyncRunsSupported(policy: DirectOpsPolicy): boolean;

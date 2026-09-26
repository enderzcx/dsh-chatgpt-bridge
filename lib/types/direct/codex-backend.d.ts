import { CodexAppServerClient, type CodexSandboxPolicy } from './codex-app-server.js';
import { type DirectOpsPolicy } from './types.js';
/** The sandbox policy actually handed to codex, plus the honest description. */
export interface CodexSandboxPlan {
    policy: CodexSandboxPolicy;
    describe: Record<string, unknown>;
}
/** What the child is ACTUALLY confined by, as opposed to what was configured. */
export interface EffectiveConfinement {
    /** True only when an OS sandbox really confines this child. */
    sandboxed: boolean;
    /** Effective network reach, not the configured intent. */
    network: 'deny' | 'allow' | 'unconfined';
    /** Effective filesystem scope, not the configured intent. */
    filesystem: 'roots' | 'inherit' | 'unconfined';
    /** Cwd is unconstrained (full access) rather than restricted to cwd roots. */
    cwdUnrestricted: boolean;
    /** Any bare executable name resolves rather than only an allowlist. */
    commandUnrestricted: boolean;
}
/**
 * Derive the effective confinement from the plan.
 *
 * This is the ONE place that decides what the result and the policy view report,
 * so a configured `network: deny` can never be echoed next to a child that is in
 * fact online.
 */
export declare function effectiveConfinement(plan: CodexSandboxPlan): EffectiveConfinement;
/** The absolute codex executable, or a refusal naming the configuration key. */
export declare function resolveCodexBinary(policy: DirectOpsPolicy): string;
/**
 * Translate the bridge's direct-ops policy into a codex sandbox policy.
 *
 * This is the single place where the two permission models meet. It is
 * intentionally one-directional: every branch is decided by the policy, and an
 * unrecognised combination fails closed instead of falling back to a wider mode.
 */
export declare function planCodexSandbox(policy: DirectOpsPolicy, cwd: string): CodexSandboxPlan;
/** Options for one codex-backed execution. */
export interface CodexRunOptions {
    cmd: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
    maxOutputBytes: number;
    env: Record<string, string>;
}
/**
 * Spawn one dedicated app server, run one job, then stop it.
 *
 * A per-execution process is what keeps sessions isolated: one run's `processId`
 * namespace, stderr and lifetime cannot collide with another's.
 */
declare function withClient<T>(policy: DirectOpsPolicy, onOutputDelta: ((stream: 'stdout' | 'stderr', text: string, capReached: boolean) => void) | undefined, job: (client: CodexAppServerClient) => Promise<T>): Promise<T>;
/**
 * Run one allowlisted command through codex and wait for it to exit.
 *
 * A timeout is reported as `exitCode: 124` by the server, which is surfaced as
 * `timedOut` rather than as an error.
 */
export declare function runCommandViaCodex(options: CodexRunOptions, policy: DirectOpsPolicy): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    /** True only when the runner's deadline was hit; see the adapter's evidence. */
    timedOut: boolean;
    timeoutEvidence: string;
    stdoutTruncated?: boolean;
    stderrTruncated?: boolean;
    resolvedBinary: string;
    sandbox: CodexSandboxPlan;
    confinement: EffectiveConfinement;
}>;
/** Start one allowlisted command as a streaming, terminable async run. */
export declare function startCommandViaCodex(options: CodexRunOptions & {
    processId: string;
}, policy: DirectOpsPolicy, onOutputDelta: (stream: 'stdout' | 'stderr', text: string, capReached: boolean) => void): Promise<{
    resolvedBinary: string;
    sandbox: CodexSandboxPlan;
    run: (client: CodexAppServerClient) => Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
    }>;
}>;
export { withClient as withCodexClient };

/** What one finished command reports back to the registry. */
export interface RunOutcome {
    exitCode: number;
    stdout: string;
    stderr: string;
    stdoutTruncated?: boolean;
    stderrTruncated?: boolean;
    /** True only when the runner's own deadline was hit (never inferred from the code). */
    timeout?: boolean;
    timeoutEvidence?: string;
}
/** One stored output chunk, tagged with its run-global sequence number. */
interface Chunk {
    seq: number;
    text: string;
}
/** One process's accumulated output. */
interface StreamState {
    chunks: Chunk[];
    bytes: number;
    truncated: boolean;
}
export interface AsyncRun {
    run_id: string;
    cmd: string;
    argv: string[];
    cwd: string;
    backend: string;
    sandbox: Record<string, unknown>;
    started_at: number;
    process_id: string;
    status: 'running' | 'exited' | 'failed' | 'terminated';
    exit_code?: number;
    timed_out?: boolean;
    /** How the timeout conclusion was reached; never asserted from the code alone. */
    timeout_evidence?: string;
    error?: string;
    finished_at?: number;
    stdout: StreamState;
    stderr: StreamState;
    /** Highest chunk sequence emitted so far. */
    seq: number;
    /** When a stop was requested; used to judge whether confirmation timed out. */
    stop_requested_at?: number;
    /** Stops the process. Supplied by the run owner; connection-scoped by design. */
    stop?: () => Promise<void>;
    /** Closes the run's own client once the process is gone. */
    dispose?: () => Promise<void>;
    promise: Promise<void>;
}
export interface RunView {
    run_id: string;
    cmd: string;
    argv: string[];
    cwd: string;
    backend: string;
    sandbox: Record<string, unknown>;
    status: AsyncRun['status'];
    exit_code?: number;
    timed_out?: boolean;
    timeout_evidence?: string;
    error?: string;
    started_at: number;
    finished_at?: number;
    duration_ms: number;
    stdout: string;
    stderr: string;
    stdout_bytes: number;
    stderr_bytes: number;
    stdout_truncated: boolean;
    stderr_truncated: boolean;
    /** Highest sequence number included in this view; pass it back as since_seq. */
    seq: number;
}
/** Bounded registry of live and recently finished async runs. */
export declare class RunRegistry {
    private readonly runs;
    private readonly maxRuns;
    private readonly maxOutputBytes;
    constructor(options: {
        maxRuns: number;
        maxOutputBytes: number;
    });
    /** Number of runs not yet finished. */
    liveCount(): number;
    /** Look up one run or refuse with a stable code. */
    get(runId: string): AsyncRun;
    /**
     * Start one command as an async run.
     *
     * The caller supplies the already-built argv and sandbox policy, so this
     * class never decides permissions; it only tracks one process's lifetime.
     */
    start(options: {
        cmd: string;
        argv: string[];
        cwd: string;
        backend: string;
        sandbox: Record<string, unknown>;
        processId: string;
        /** Per-stream byte budget for this run, from the server-side policy. */
        maxOutputBytes: number;
        /**
         * Runs the command. The callback receives the run's own client, so the
         * process id stays scoped to the one connection that owns it, and returns a
         * `stop` hook that can terminate that same process.
         */
        run: (onDelta: (stream: 'stdout' | 'stderr', text: string, capReached: boolean) => void) => {
            result: Promise<RunOutcome>;
            stop: () => Promise<void>;
            dispose: () => Promise<void>;
        };
    }): RunView;
    /**
     * Record that a run was asked to stop.
     *
     * This deliberately does NOT change the status: a stop request is not proof
     * that the process is gone, and reporting `terminated` while the process is
     * still alive would both lie and release the concurrency slot to a live
     * process. The status flips only when the run's own result settles.
     */
    markStopRequested(runId: string): AsyncRun;
    /** Record the confirmed end of a stopped run, once its process really exited. */
    markTerminated(runId: string): AsyncRun;
    /** Wait until one run leaves the running state, or the bound elapses. */
    awaitSettled(runId: string, timeoutMs: number): Promise<AsyncRun>;
    /** Read one run's output, optionally only chunks newer than `sinceSeq`. */
    view(runId: string, sinceSeq?: number): RunView;
    /** Keep finished runs bounded so the registry cannot grow without limit. */
    private evict;
}
export {};

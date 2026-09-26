/**
 * Async execution runs for the direct command surface.
 *
 * A long command would otherwise block one MCP call until the timeout. A run
 * started with `async: true` is held here instead: the caller gets a `run_id`
 * back immediately and then reads incremental output or terminates it. The
 * command is never started twice — one `run_id` owns exactly one process.
 *
 * Output is stored per stream up to the configured bound, with an explicit
 * truncation flag, plus a monotonic chunk sequence so a caller can read only
 * what arrived since its last poll. Every run keeps the sandbox policy that was
 * actually applied, so a caller can verify what it got.
 */
import { randomUUID } from 'node:crypto';
import { truncateToUtf8Bytes } from './codex-app-server.js';
import { DirectOpsError } from './types.js';
/** Bounded registry of live and recently finished async runs. */
export class RunRegistry {
    runs = new Map();
    maxRuns;
    maxOutputBytes;
    constructor(options) {
        this.maxRuns = Math.max(1, options.maxRuns);
        // No floor here: the policy owns the lower bound, and a run may legitimately
        // be given a small explicit budget that must be honoured exactly.
        this.maxOutputBytes = Math.max(1, Math.trunc(options.maxOutputBytes));
    }
    /** Number of runs not yet finished. */
    liveCount() {
        let live = 0;
        for (const run of this.runs.values())
            if (run.status === 'running')
                live += 1;
        return live;
    }
    /** Look up one run or refuse with a stable code. */
    get(runId) {
        const run = this.runs.get(runId);
        if (run === undefined) {
            throw new DirectOpsError('RUN_NOT_FOUND', 'no such run_id; it may have been evicted or never existed', {
                run_id: runId,
                known_run_ids: [...this.runs.keys()],
            });
        }
        return run;
    }
    /**
     * Start one command as an async run.
     *
     * The caller supplies the already-built argv and sandbox policy, so this
     * class never decides permissions; it only tracks one process's lifetime.
     */
    start(options) {
        if (this.liveCount() >= this.maxRuns) {
            throw new DirectOpsError('RUN_LIMIT_REACHED', `the async run limit (${this.maxRuns}) is already in use; terminate or drain a run before starting another`, {
                max_runs: this.maxRuns,
                live_run_ids: [...this.runs.values()].filter((r) => r.status === 'running').map((r) => r.run_id),
            });
        }
        const runId = `run-${randomUUID()}`;
        // One run's budget is its own; the registry-wide bound is only a default.
        const budget = Math.max(1, Math.trunc(options.maxOutputBytes));
        const run = {
            run_id: runId,
            cmd: options.cmd,
            argv: options.argv,
            cwd: options.cwd,
            backend: options.backend,
            sandbox: options.sandbox,
            started_at: Date.now(),
            process_id: options.processId,
            status: 'running',
            stdout: { chunks: [], bytes: 0, truncated: false },
            stderr: { chunks: [], bytes: 0, truncated: false },
            seq: 0,
            promise: Promise.resolve(),
        };
        const append = (stream, text, capReached) => {
            const state = stream === 'stderr' ? run.stderr : run.stdout;
            // `capReached` can arrive on an empty final delta, so the flag must be
            // recorded even when there are no bytes to store.
            if (capReached)
                state.truncated = true;
            if (text === '')
                return;
            const remaining = budget - state.bytes;
            if (remaining <= 0) {
                state.truncated = true;
                return;
            }
            // Byte-accurate, character-safe: `.slice` on the string would count UTF-16
            // code units and could overshoot the budget or split a character.
            const kept = truncateToUtf8Bytes(text, remaining);
            if (kept.text === '') {
                state.truncated = true;
                return;
            }
            run.seq += 1;
            state.chunks.push({ seq: run.seq, text: kept.text });
            state.bytes += kept.bytes;
            if (kept.text.length !== text.length)
                state.truncated = true;
        };
        // The client returns cumulative output even after streaming it. Track the
        // delivery channel per stream; do not deduplicate equal text, since a
        // program may legitimately print the same line more than once.
        const streamed = { stdout: false, stderr: false };
        let started;
        try {
            started = options.run((stream, text, capReached) => {
                streamed[stream] = true;
                append(stream, text, capReached);
            });
        }
        catch (error) {
            run.status = 'failed';
            run.error = error instanceof Error ? error.message : String(error);
            run.finished_at = Date.now();
            this.runs.set(runId, run);
            return this.view(runId, 0);
        }
        run.stop = started.stop;
        run.dispose = started.dispose;
        run.promise = Promise.resolve(started.result).then((result) => {
            // Only use the cumulative result for a stream that sent no callbacks.
            // Re-appending streamed bytes would duplicate output, inflate counters,
            // and replay old data to a since_seq reader when the command exits.
            if (!streamed.stdout && result.stdout !== '')
                append('stdout', result.stdout, result.stdoutTruncated === true);
            if (!streamed.stderr && result.stderr !== '')
                append('stderr', result.stderr, result.stderrTruncated === true);
            if (result.stdoutTruncated === true)
                run.stdout.truncated = true;
            if (result.stderrTruncated === true)
                run.stderr.truncated = true;
            run.exit_code = result.exitCode;
            // `exitCode === 124` alone is not proof of a timeout: a command may exit
            // 124 itself. Only the client's evidence (wall time at the deadline) is
            // reported, and the raw exit code always survives.
            run.timed_out = result.timeout === true;
            run.timeout_evidence = result.timeoutEvidence;
            // A run that was asked to stop reports 'terminated' once its process is
            // confirmed gone, so the caller sees the outcome it asked for rather than
            // a bare 'exited'.
            run.status = run.stop_requested_at !== undefined ? 'terminated' : 'exited';
            run.finished_at = Date.now();
        }, (error) => {
            run.status = run.stop_requested_at !== undefined ? 'terminated' : 'failed';
            run.error = error instanceof Error ? error.message : String(error);
            run.finished_at = Date.now();
        }).then(async () => {
            // The process is gone; release this run's dedicated connection.
            try {
                await run.dispose?.();
            }
            catch { /* closing a finished run cannot fail the run */ }
        });
        this.runs.set(runId, run);
        this.evict();
        return this.view(runId, 0);
    }
    /**
     * Record that a run was asked to stop.
     *
     * This deliberately does NOT change the status: a stop request is not proof
     * that the process is gone, and reporting `terminated` while the process is
     * still alive would both lie and release the concurrency slot to a live
     * process. The status flips only when the run's own result settles.
     */
    markStopRequested(runId) {
        const run = this.get(runId);
        run.stop_requested_at = Date.now();
        return run;
    }
    /** Record the confirmed end of a stopped run, once its process really exited. */
    markTerminated(runId) {
        const run = this.get(runId);
        if (run.status === 'terminated')
            return run;
        if (run.status !== 'running')
            return run;
        run.status = 'terminated';
        run.finished_at = Date.now();
        return run;
    }
    /** Wait until one run leaves the running state, or the bound elapses. */
    async awaitSettled(runId, timeoutMs) {
        const run = this.get(runId);
        await Promise.race([run.promise, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
        return run;
    }
    /** Read one run's output, optionally only chunks newer than `sinceSeq`. */
    view(runId, sinceSeq = 0) {
        const run = this.get(runId);
        const collect = (state) => state.chunks.filter((chunk) => chunk.seq > sinceSeq).map((chunk) => chunk.text).join('');
        const stdout = collect(run.stdout);
        const stderr = collect(run.stderr);
        return {
            run_id: run.run_id,
            cmd: run.cmd,
            argv: run.argv,
            cwd: run.cwd,
            backend: run.backend,
            sandbox: run.sandbox,
            status: run.status,
            ...(run.exit_code === undefined ? {} : { exit_code: run.exit_code }),
            ...(run.timed_out === undefined ? {} : { timed_out: run.timed_out }),
            ...(run.timeout_evidence === undefined ? {} : { timeout_evidence: run.timeout_evidence }),
            ...(run.error === undefined ? {} : { error: run.error }),
            started_at: run.started_at,
            ...(run.finished_at === undefined ? {} : { finished_at: run.finished_at }),
            duration_ms: (run.finished_at ?? Date.now()) - run.started_at,
            stdout,
            stderr,
            stdout_bytes: run.stdout.bytes,
            stderr_bytes: run.stderr.bytes,
            stdout_truncated: run.stdout.truncated,
            stderr_truncated: run.stderr.truncated,
            seq: run.seq,
        };
    }
    /** Keep finished runs bounded so the registry cannot grow without limit. */
    evict() {
        const maxFinished = Math.max(4, this.maxRuns * 4);
        const finished = [...this.runs.values()].filter((run) => run.status !== 'running');
        if (finished.length <= maxFinished)
            return;
        finished.sort((a, b) => (a.finished_at ?? 0) - (b.finished_at ?? 0));
        for (const run of finished.slice(0, finished.length - maxFinished))
            this.runs.delete(run.run_id);
    }
}

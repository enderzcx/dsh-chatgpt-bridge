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
export class RunRegistry {
  private readonly runs = new Map<string, AsyncRun>();
  private readonly maxRuns: number;
  private readonly maxOutputBytes: number;

  constructor(options: { maxRuns: number; maxOutputBytes: number }) {
    this.maxRuns = Math.max(1, options.maxRuns);
    // No floor here: the policy owns the lower bound, and a run may legitimately
    // be given a small explicit budget that must be honoured exactly.
    this.maxOutputBytes = Math.max(1, Math.trunc(options.maxOutputBytes));
  }

  /** Number of runs not yet finished. */
  liveCount(): number {
    let live = 0;
    for (const run of this.runs.values()) if (run.status === 'running') live += 1;
    return live;
  }

  /** Look up one run or refuse with a stable code. */
  get(runId: string): AsyncRun {
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
    run: (
      onDelta: (stream: 'stdout' | 'stderr', text: string, capReached: boolean) => void,
    ) => {
      result: Promise<RunOutcome>;
      stop: () => Promise<void>;
      dispose: () => Promise<void>;
    };
  }): RunView {
    if (this.liveCount() >= this.maxRuns) {
      throw new DirectOpsError(
        'RUN_LIMIT_REACHED',
        `the async run limit (${this.maxRuns}) is already in use; terminate or drain a run before starting another`,
        {
          max_runs: this.maxRuns,
          live_run_ids: [...this.runs.values()].filter((r) => r.status === 'running').map((r) => r.run_id),
        },
      );
    }
    const runId = `run-${randomUUID()}`;
    // One run's budget is its own; the registry-wide bound is only a default.
    const budget = Math.max(1, Math.trunc(options.maxOutputBytes));
    const run: AsyncRun = {
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
    const append = (stream: 'stdout' | 'stderr', text: string, capReached: boolean): void => {
      const state = stream === 'stderr' ? run.stderr : run.stdout;
      // `capReached` can arrive on an empty final delta, so the flag must be
      // recorded even when there are no bytes to store.
      if (capReached) state.truncated = true;
      if (text === '') return;
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
      if (kept.text.length !== text.length) state.truncated = true;
    };
    // The client returns cumulative output even after streaming it. Track the
    // delivery channel per stream; do not deduplicate equal text, since a
    // program may legitimately print the same line more than once.
    const streamed = { stdout: false, stderr: false };
    type StartedRun = ReturnType<typeof options.run>;
    let started: StartedRun;
    try {
      started = options.run((stream, text, capReached) => {
        streamed[stream] = true;
        append(stream, text, capReached);
      });
    } catch (error) {
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
      if (!streamed.stdout && result.stdout !== '') append('stdout', result.stdout, result.stdoutTruncated === true);
      if (!streamed.stderr && result.stderr !== '') append('stderr', result.stderr, result.stderrTruncated === true);
      if (result.stdoutTruncated === true) run.stdout.truncated = true;
      if (result.stderrTruncated === true) run.stderr.truncated = true;
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
    }, (error: unknown) => {
      run.status = run.stop_requested_at !== undefined ? 'terminated' : 'failed';
      run.error = error instanceof Error ? error.message : String(error);
      run.finished_at = Date.now();
    }).then(async () => {
      // The process is gone; release this run's dedicated connection.
      try { await run.dispose?.(); } catch { /* closing a finished run cannot fail the run */ }
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
  markStopRequested(runId: string): AsyncRun {
    const run = this.get(runId);
    run.stop_requested_at = Date.now();
    return run;
  }

  /** Record the confirmed end of a stopped run, once its process really exited. */
  markTerminated(runId: string): AsyncRun {
    const run = this.get(runId);
    if (run.status === 'terminated') return run;
    if (run.status !== 'running') return run;
    run.status = 'terminated';
    run.finished_at = Date.now();
    return run;
  }

  /** Wait until one run leaves the running state, or the bound elapses. */
  async awaitSettled(runId: string, timeoutMs: number): Promise<AsyncRun> {
    const run = this.get(runId);
    await Promise.race([run.promise, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
    return run;
  }

  /** Read one run's output, optionally only chunks newer than `sinceSeq`. */
  view(runId: string, sinceSeq = 0): RunView {
    const run = this.get(runId);
    const collect = (state: StreamState): string =>
      state.chunks.filter((chunk) => chunk.seq > sinceSeq).map((chunk) => chunk.text).join('');
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
  private evict(): void {
    const maxFinished = Math.max(4, this.maxRuns * 4);
    const finished = [...this.runs.values()].filter((run) => run.status !== 'running');
    if (finished.length <= maxFinished) return;
    finished.sort((a, b) => (a.finished_at ?? 0) - (b.finished_at ?? 0));
    for (const run of finished.slice(0, finished.length - maxFinished)) this.runs.delete(run.run_id);
  }
}

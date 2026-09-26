/**
 * Codex app-server `command/exec` client.
 *
 * The bridge uses this as an alternative command backend: the cloud ChatGPT
 * client asks the bridge to run a local argv vector, the bridge forwards that
 * to a local `codex app-server` over stdio JSON-RPC, and Codex runs it in its
 * own OS sandbox. **No model is involved**: `command/exec` is a standalone
 * execution API and the bridge never sends `thread/start` or `turn/start`, so
 * no thread, turn, or model call is ever created.
 *
 * Contract (verified against the installed codex-cli 0.133.0 schema generated
 * by `codex app-server generate-json-schema`):
 *   - `initialize` {clientInfo, capabilities} then an `initialized` notification
 *   - `command/exec` {command: string[], cwd?, env?, sandboxPolicy?, timeoutMs?,
 *     processId?, streamStdoutStderr?, outputBytesCap?, disableTimeout?}
 *     → deferred result `{exitCode, stdout, stderr}`; buffered output is empty
 *     for a streamed stream
 *   - `command/exec/outputDelta` {processId, stream: 'stdout'|'stderr',
 *     deltaBase64, capReached} — connection-scoped notifications
 *   - `command/exec/write` / `command/exec/terminate` — stdin and stop
 *   - a timeout is reported as `exitCode: 124`, not as an RPC error
 *
 * Only the newer `processId`-based streaming API is used. The legacy
 * `command/exec/output` replay form is deliberately not supported, so the
 * bridge cannot silently depend on it.
 *
 * The child is launched with a minimal environment: nothing from the bridge's
 * own environment is forwarded except what the policy explicitly allows, so no
 * credential, token, or unrelated variable can reach it. Nothing here reads or
 * prints credentials, signs in, or touches the user's Codex configuration.
 */
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { scrubSecrets } from './secrets.js';
import { BRIDGE_VERSION } from '../version.js';

/** Sandbox policy shapes accepted by the app server, mirroring its schema. */
export type CodexSandboxPolicy =
  | { type: 'readOnly'; networkAccess?: boolean }
  | { type: 'workspaceWrite'; writableRoots?: string[]; networkAccess?: boolean; excludeTmpdirEnvVar?: boolean; excludeSlashTmp?: boolean }
  | { type: 'dangerFullAccess' };

export interface CodexExecRequest {
  /** Argv vector; the executable is resolved by the server, never by a shell. */
  command: string[];
  cwd?: string;
  /** Environment overrides merged into the server-computed environment. */
  env?: Record<string, string | null>;
  sandboxPolicy: CodexSandboxPolicy;
  timeoutMs?: number;
  /** Ask the server for no deadline at all; the caller then owns the lifetime. */
  disableTimeout?: boolean;
  /** Client-supplied connection-scoped id, required to stream or terminate. */
  processId?: string;
  streamStdoutStderr?: boolean;
  outputBytesCap?: number;
}

export interface CodexExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /**
   * Whether the streamed output hit `outputBytesCap`, as reported by the
   * server's own `capReached` flag. `undefined` means the client did not read
   * this stream through notifications, so nothing can be claimed about it.
   */
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  /**
   * Whether the server reported that the runner hit its own deadline.
   *
   * `exitCode === 124` is NOT proof of that: a command may simply exit 124
   * itself. This flag is only set when the run consumed essentially the whole
   * configured timeout, which is the runner's own kill signature; the raw
   * `exitCode` is always preserved either way.
   */
  timeout: boolean;
  /** How `timeout` was decided, so a caller can see it is an inference. */
  timeoutEvidence: 'wall-time-at-or-past-deadline' | 'none';
  /** Wall time the server spent on this command. */
  durationMs: number;
}

/** One streamed output chunk. */
export interface CodexOutputDelta {
  processId: string;
  stream: 'stdout' | 'stderr';
  /** The chunk decoded as UTF-8, for callers that only want text. */
  text: string;
  /**
   * The exact bytes the server sent.
   *
   * A chunk can split a multi-byte character, so re-encoding `text` would lose
   * or corrupt those bytes. Consumers that need fidelity must accumulate these.
   */
  bytes: Buffer;
  capReached: boolean;
}

export interface CodexClientOptions {
  /** Absolute path to the codex executable. */
  binPath: string;
  /** Extra argv before `app-server` (for example a `-c key=value` override). */
  binArgs?: string[];
  /** Environment for the app-server child. Keep this minimal. */
  env: Record<string, string>;
  /** How long to wait for the initialize handshake. */
  handshakeTimeoutMs?: number;
  /** Called for every streamed output chunk. */
  onOutputDelta?: (delta: CodexOutputDelta) => void;
  /** Called with a human-readable line when the child writes to stderr. */
  onStderr?: (line: string) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

/** Raised for any adapter-level failure, with a stable code for the bridge. */
export class CodexClientError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'CodexClientError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20000;
/**
 * Largest single stdout line accepted from the server. A server that writes an
 * unbounded line would otherwise grow the readline buffer without limit.
 */
const MAX_PROTOCOL_LINE_BYTES = 8 * 1024 * 1024;
/** Bytes of server stderr kept for diagnostics (and scrubbed before reporting). */
const STDERR_TAIL_BYTES = 8192;
/** Methods this client is allowed to send. Anything thread/turn-shaped is absent. */
const ALLOWED_METHODS = new Set([
  'initialize',
  'initialized',
  'command/exec',
  'command/exec/write',
  'command/exec/terminate',
]);

/**
 * Truncate `text` to at most `maxBytes` UTF-8 bytes without splitting a
 * character.
 *
 * Slicing by `.length` counts UTF-16 code units, not bytes, so it both overshoots
 * the byte budget and can cut a surrogate pair or a multi-byte character in half.
 * @returns the kept text and its exact byte length.
 */
export function truncateToUtf8Bytes(text: string, maxBytes: number): { text: string; bytes: number } {
  if (maxBytes <= 0) return { text: '', bytes: 0 };
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.byteLength <= maxBytes) return { text, bytes: encoded.byteLength };
  // Walk back from the cut to the previous character boundary.
  let end = maxBytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  const kept = encoded.subarray(0, end).toString('utf8');
  return { text: kept, bytes: Buffer.byteLength(kept, 'utf8') };
}

/** Scrub credential-shaped text out of a diagnostic tail and bound it. */
function redactTail(text: string): string {
  return scrubSecrets(text).slice(-STDERR_TAIL_BYTES);
}

/**
 * Decode a byte stream to text without corrupting split UTF-8 sequences.
 *
 * The server sends base64 chunks that can split a multi-byte character across
 * two notifications. Decoding each chunk on its own would turn those bytes into
 * replacement characters, so incomplete trailing bytes are held until the next
 * chunk completes them (`TextDecoder` in streaming mode does exactly that).
 */
class Utf8StreamDecoder {
  private decoder = new TextDecoder('utf-8', { fatal: false });

  /** Decode `chunk`, returning only the text that is complete so far. */
  push(chunk: Buffer): string {
    return this.decoder.decode(chunk, { stream: true });
  }

  /** Flush any final bytes (a truncated tail becomes U+FFFD, which is honest). */
  flush(): string {
    return this.decoder.decode();
  }
}

/**
 * One live `codex app-server` stdio connection.
 *
 * Request/response pairing is by JSON-RPC id; notifications are routed to the
 * output-delta callback. The connection is single-flight per request id and
 * every request has its own timeout, so a hung child cannot wedge the bridge.
 */
export class CodexAppServerClient {
  private readonly opts: CodexClientOptions;
  private child?: ChildProcessWithoutNullStreams;
  private rl?: ReadlineInterface;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private closed = false;
  private stderrBuffer = '';
  private stderrBytes = 0;
  /** Frames the server sent that were not valid JSON-RPC objects. */
  readonly protocolFaults: string[] = [];
  /** Every method actually sent, for the "no thread/turn" evidence assertion. */
  readonly sentMethods: string[] = [];

  constructor(options: CodexClientOptions) {
    this.opts = options;
  }

  /** Whether the child is still running and not yet closed by this client. */
  get alive(): boolean {
    return this.child !== undefined && this.child.exitCode === null && !this.closed;
  }

  /** Start the child and complete the initialize handshake. */
  async start(): Promise<{ userAgent?: string; codexHome?: string; platformOs?: string }> {
    if (this.child !== undefined) throw new CodexClientError('CODEX_ALREADY_STARTED', 'client already started');
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.opts.binPath, [...(this.opts.binArgs ?? []), 'app-server', '--listen', 'stdio://'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.opts.env,
      });
    } catch (error) {
      throw new CodexClientError(
        'CODEX_SPAWN_FAILED',
        `could not start the codex app server: ${error instanceof Error ? error.message : String(error)}`,
        { bin: this.opts.binPath },
      );
    }
    this.child = child;
    child.on('error', (error) => {
      this.failAll(new CodexClientError('CODEX_SPAWN_FAILED', `codex app server error: ${error.message}`));
    });
    child.on('exit', (code, signal) => {
      this.closed = true;
      this.failAll(new CodexClientError(
        'CODEX_EXITED',
        `codex app server exited (code ${String(code)}, signal ${String(signal)})`,
        { exit_code: code, signal },
      ));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // Bounded by bytes, not lines: a server that never emits a newline must
      // not be able to grow this buffer without limit.
      this.stderrBytes += chunk.byteLength;
      this.stderrBuffer = `${this.stderrBuffer}${chunk.toString()}`;
      if (this.stderrBuffer.length > STDERR_TAIL_BYTES) {
        this.stderrBuffer = this.stderrBuffer.slice(-STDERR_TAIL_BYTES);
      }
      this.opts.onStderr?.(chunk.toString().slice(0, 500));
    });
    this.rl = createInterface({ input: child.stdout });
    this.rl.on('line', (line) => this.onLine(line));

    let result: unknown;
    try {
      result = await this.request(
        'initialize',
        {
          clientInfo: { name: 'dsh-chatgpt-bridge', version: BRIDGE_VERSION },
          // The command/exec surface is part of the experimental API set.
          capabilities: { experimentalApi: true },
        },
        this.opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      );
    } catch (error) {
      // A failed handshake must not leave a live child behind; a later close()
      // is a no-op, so this is the only chance to reap it.
      this.closed = true;
      this.failAll(new CodexClientError('CODEX_INIT_FAILED', 'initialize handshake failed'));
      this.rl?.close();
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      throw error;
    }
    this.notify('initialized', {});
    const info = (result ?? {}) as { userAgent?: string; codexHome?: string; platformOs?: string };
    return info;
  }

  /** The scrubbed tail of the child's stderr, for diagnostics only. */
  stderrTail(): string {
    return redactTail(this.stderrBuffer);
  }

  /** Route one stdout line: a response to a pending request, or a notification. */
  private onLine(line: string): void {
    if (line.trim() === '') return;
    if (line.length > MAX_PROTOCOL_LINE_BYTES) {
      // Refuse an absurd frame rather than parsing it; the connection is not
      // trusted to be well-behaved.
      this.protocolFaults.push(`oversize frame (${line.length} chars) ignored`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // A non-JSON line is not protocol traffic; ignore it rather than crashing.
    }
    // `JSON.parse` happily returns null, numbers, strings and arrays. None of
    // those are a JSON-RPC message, so they are dropped instead of throwing.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.protocolFaults.push('non-object frame ignored');
      return;
    }
    const message = parsed as { id?: unknown; method?: unknown; result?: unknown; error?: unknown; params?: unknown };
    if (typeof message.id === 'number' && this.pending.has(message.id)) {
      const request = this.pending.get(message.id);
      if (request === undefined) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error !== undefined) {
        request.reject(new CodexClientError(
          'CODEX_RPC_ERROR',
          `codex app server rejected ${request.method}: ${JSON.stringify(message.error)}`,
          { method: request.method, error: message.error },
        ));
      } else {
        request.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === 'string') this.onNotification(message.method, message.params);
  }

  /** Handle one server notification; only exec output is meaningful here. */
  private onNotification(method: string, params: unknown): void {
    if (method !== 'command/exec/outputDelta') return;
    const payload = params as {
      processId?: unknown;
      stream?: unknown;
      deltaBase64?: unknown;
      capReached?: unknown;
    } | undefined;
    if (payload === undefined || typeof payload.processId !== 'string') return;
    const stream = payload.stream === 'stderr' ? 'stderr' : 'stdout';
    const bytes = typeof payload.deltaBase64 === 'string'
      ? Buffer.from(payload.deltaBase64, 'base64')
      : Buffer.alloc(0);
    this.opts.onOutputDelta?.({
      processId: payload.processId,
      stream,
      text: bytes.toString('utf8'),
      bytes,
      capReached: payload.capReached === true,
    });
  }

  /** Reject every in-flight request; used when the child dies. */
  private failAll(error: Error): void {
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer);
      this.pending.delete(id);
      request.reject(error);
    }
  }

  /** Send one request and await its result, with a per-request timeout. */
  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new CodexClientError('CODEX_NOT_RUNNING', 'codex app server is not running'));
    if (!ALLOWED_METHODS.has(method)) {
      // A guard, not a policy: it keeps thread/turn-shaped calls out of this client
      // entirely, so "the bridge never starts a thread or turn" stays true by code.
      return Promise.reject(new CodexClientError(
        'CODEX_METHOD_NOT_ALLOWED',
        `${method} is not part of the command/exec surface this client is allowed to use`,
        { method },
      ));
    }
    const child = this.child;
    if (child === undefined) return Promise.reject(new CodexClientError('CODEX_NOT_RUNNING', 'codex app server is not running'));
    const id = this.nextId++;
    this.sentMethods.push(method);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexClientError(
          'CODEX_REQUEST_TIMEOUT',
          `codex app server did not answer ${method} within ${timeoutMs}ms; stderr tail: ${this.stderrTail()}`,
          { method, timeout_ms: timeoutMs },
        ));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
        if (error === undefined || error === null) return;
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        this.pending.delete(id);
        clearTimeout(timer);
        // A broken pipe means the child is gone; reap it and fail every other
        // in-flight request rather than reporting only this one.
        this.closed = true;
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        const wrapped = new CodexClientError('CODEX_WRITE_FAILED', `could not write ${method}: ${error.message}`, { method });
        this.failAll(wrapped);
        reject(wrapped);
      });
    });
  }

  /** Send one JSON-RPC notification (no response expected). */
  private notify(method: string, params: unknown): void {
    if (this.child === undefined || this.closed) return;
    this.sentMethods.push(method);
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  /**
   * Run one argv vector and wait for it to exit.
   *
   * Output is always collected through `command/exec/outputDelta` rather than
   * the buffered response, because only the notifications carry the server's
   * own `capReached` truncation flag. That makes "this output was truncated" a
   * reported fact instead of an inference from byte counts.
   *
   * A `timeoutMs` expiry arrives as `exitCode: 124`, but so does a command that
   * chooses to exit 124. The two are distinguished by wall time (see
   * {@link CodexExecResult.timeout}) and the raw exit code is always preserved.
   */
  async exec(request: CodexExecRequest): Promise<CodexExecResult> {
    if (request.command.length === 0) {
      throw new CodexClientError('CODEX_EMPTY_COMMAND', 'command argv must not be empty');
    }
    const processId = request.processId ?? `dsh-exec-${randomUUID()}`;
    const stdoutDecoder = new Utf8StreamDecoder();
    const stderrDecoder = new Utf8StreamDecoder();
    const stdoutParts: string[] = [];
    const stderrParts: string[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let stdoutCapReached = false;
    let stderrCapReached = false;
    // Bound what this client holds even if the server's own cap is larger, so a
    // misconfigured or hostile server cannot exhaust the bridge's memory.
    const localCap = request.outputBytesCap ?? Number.MAX_SAFE_INTEGER;
    const keep = (parts: string[], text: string, used: number): { text: string; used: number } => {
      if (text === '') return { text, used };
      const remaining = localCap - used;
      if (remaining <= 0) return { text: '', used };
      const kept = truncateToUtf8Bytes(text, remaining);
      parts.push(kept.text);
      return { text: kept.text, used: used + kept.bytes };
    };
    const inner = this.opts.onOutputDelta;
    this.opts.onOutputDelta = (delta) => {
      if (delta.processId !== processId) {
        inner?.(delta);
        return;
      }
      let forwardedText = '';
      let localTruncated = false;
      if (delta.stream === 'stderr') {
        const decoded = stderrDecoder.push(delta.bytes);
        if (delta.capReached) stderrCapReached = true;
        const added = keep(stderrParts, decoded, stderrBytes);
        stderrBytes = added.used;
        forwardedText = added.text;
        if (added.text.length !== decoded.length) stderrTruncated = true;
        localTruncated = stderrTruncated;
      } else {
        const decoded = stdoutDecoder.push(delta.bytes);
        if (delta.capReached) stdoutCapReached = true;
        const added = keep(stdoutParts, decoded, stdoutBytes);
        stdoutBytes = added.used;
        forwardedText = added.text;
        if (added.text.length !== decoded.length) stdoutTruncated = true;
        localTruncated = stdoutTruncated;
      }
      // Live readers must receive the same decoded, bounded text as the final
      // collector, not a raw chunk decoded independently in mid-character.
      // Keep the original bytes available to consumers that explicitly use them.
      inner?.({ ...delta, text: forwardedText, capReached: delta.capReached || localTruncated });
    };

    const params: Record<string, unknown> = {
      command: [...request.command],
      sandboxPolicy: request.sandboxPolicy,
      // Always streaming: the deltas are the only truncation-aware channel.
      processId,
      streamStdoutStderr: true,
    };
    if (request.cwd !== undefined) params.cwd = request.cwd;
    if (request.env !== undefined) params.env = request.env;
    if (request.outputBytesCap !== undefined) params.outputBytesCap = request.outputBytesCap;
    // The RPC wait is not the process deadline. Forward the actual deadline so
    // the server does not silently fall back to its default (10s on this host).
    if (request.timeoutMs !== undefined) params.timeoutMs = request.timeoutMs;
    if (request.disableTimeout !== undefined) params.disableTimeout = request.disableTimeout;
    // The caller owns the deadline through the server when one is requested, so
    // the RPC wait simply has to outlive it.
    const waitMs = request.timeoutMs === undefined
      ? (request.disableTimeout === true ? 24 * 60 * 60 * 1000 : 600_000)
      : request.timeoutMs + 30_000;
    const startedAt = Date.now();
    let result: { exitCode?: unknown; stdout?: unknown; stderr?: unknown } | undefined;
    try {
      result = await this.request('command/exec', params, waitMs) as typeof result;
    } finally {
      this.opts.onOutputDelta = inner;
    }
    // Measured around the request itself. Folding in app-server startup would
    // make a short command look like it consumed a long deadline and would
    // mislabel a self-chosen exit 124 as a runner timeout.
    const durationMs = Date.now() - startedAt;
    // The stream's trailing bytes are flushed only now, so a command whose last
    // character was split across the final chunk is not corrupted.
    const stdoutTail = stdoutDecoder.flush();
    const stderrTail = stderrDecoder.flush();
    if (stdoutTail !== '') {
      const added = keep(stdoutParts, stdoutTail, stdoutBytes);
      stdoutBytes = added.used;
      if (added.text.length !== stdoutTail.length) stdoutTruncated = true;
      inner?.({ processId, stream: 'stdout', text: added.text, bytes: Buffer.alloc(0), capReached: stdoutTruncated });
    }
    if (stderrTail !== '') {
      const added = keep(stderrParts, stderrTail, stderrBytes);
      stderrBytes = added.used;
      if (added.text.length !== stderrTail.length) stderrTruncated = true;
      inner?.({ processId, stream: 'stderr', text: added.text, bytes: Buffer.alloc(0), capReached: stderrTruncated });
    }
    if (stdoutCapReached) stdoutTruncated = true;
    if (stderrCapReached) stderrTruncated = true;

    if (result === undefined || typeof result.exitCode !== 'number') {
      throw new CodexClientError('CODEX_BAD_RESULT', 'command/exec returned no exit code', { result });
    }
    // Measured: this codex build puts the output in the buffered response AND
    // emits outputDelta notifications. The streamed bytes are preferred because
    // they carry `capReached`; the buffered copy is only a fallback for a build
    // that does not stream at all, and in that case truncation is unknown rather
    // than "false".
    let stdout = stdoutParts.join('');
    let stderr = stderrParts.join('');
    let stdOutTruncatedFinal: boolean | undefined = stdoutTruncated;
    let stdErrTruncatedFinal: boolean | undefined = stderrTruncated;
    if (stdout === '' && typeof result.stdout === 'string' && result.stdout !== '') {
      stdout = result.stdout;
      stdOutTruncatedFinal = undefined;
    }
    if (stderr === '' && typeof result.stderr === 'string' && result.stderr !== '') {
      stderr = result.stderr;
      stdErrTruncatedFinal = undefined;
    }

    // Decide whether exit 124 was the runner's deadline or the command's choice.
    let timeout = false;
    let timeoutEvidence: CodexExecResult['timeoutEvidence'] = 'none';
    if (result.exitCode === 124) {
      const budget = request.timeoutMs;
      // Measured: this build needs several seconds beyond the deadline to kill
      // the process tree, so the window must be generous. The signal that
      // matters is "the command ran at least as long as the deadline"; a fast
      // exit 124 is the program's own choice and is left alone. The raw exit
      // code and duration are always returned, so the inference is auditable.
      if (budget !== undefined && durationMs >= budget) {
        timeout = true;
        timeoutEvidence = 'wall-time-at-or-past-deadline';
      }
    }
    return {
      exitCode: result.exitCode,
      stdout,
      stderr,
      ...(stdOutTruncatedFinal === undefined ? {} : { stdoutTruncated: stdOutTruncatedFinal }),
      ...(stdErrTruncatedFinal === undefined ? {} : { stderrTruncated: stdErrTruncatedFinal }),
      timeout,
      timeoutEvidence,
      durationMs,
    };
  }

  /** Terminate one running processId. */
  async terminate(processId: string): Promise<void> {
    await this.request('command/exec/terminate', { processId }, 15_000);
  }

  /** Write stdin bytes to one running processId, optionally closing stdin. */
  async write(processId: string, delta: string, closeStdin = false): Promise<void> {
    const params: Record<string, unknown> = { processId, deltaBase64: Buffer.from(delta, 'utf8').toString('base64') };
    if (closeStdin) params.closeStdin = true;
    await this.request('command/exec/write', params, 15_000);
  }

  /** Close the connection and stop the child, terminating any live processes. */
  async close(): Promise<void> {
    if (this.closed && this.child === undefined) return;
    this.closed = true;
    this.failAll(new CodexClientError('CODEX_CLOSED', 'client closed'));
    this.rl?.close();
    const child = this.child;
    if (child === undefined) return;
    // Closing the connection makes the server terminate its processes, so the
    // child is stopped only after its own stdio closes.
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  }
}

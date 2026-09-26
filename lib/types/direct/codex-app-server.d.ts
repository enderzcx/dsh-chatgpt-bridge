/** Sandbox policy shapes accepted by the app server, mirroring its schema. */
export type CodexSandboxPolicy = {
    type: 'readOnly';
    networkAccess?: boolean;
} | {
    type: 'workspaceWrite';
    writableRoots?: string[];
    networkAccess?: boolean;
    excludeTmpdirEnvVar?: boolean;
    excludeSlashTmp?: boolean;
} | {
    type: 'dangerFullAccess';
};
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
/** Raised for any adapter-level failure, with a stable code for the bridge. */
export declare class CodexClientError extends Error {
    readonly code: string;
    readonly details?: Record<string, unknown>;
    constructor(code: string, message: string, details?: Record<string, unknown>);
}
/**
 * Truncate `text` to at most `maxBytes` UTF-8 bytes without splitting a
 * character.
 *
 * Slicing by `.length` counts UTF-16 code units, not bytes, so it both overshoots
 * the byte budget and can cut a surrogate pair or a multi-byte character in half.
 * @returns the kept text and its exact byte length.
 */
export declare function truncateToUtf8Bytes(text: string, maxBytes: number): {
    text: string;
    bytes: number;
};
/**
 * One live `codex app-server` stdio connection.
 *
 * Request/response pairing is by JSON-RPC id; notifications are routed to the
 * output-delta callback. The connection is single-flight per request id and
 * every request has its own timeout, so a hung child cannot wedge the bridge.
 */
export declare class CodexAppServerClient {
    private readonly opts;
    private child?;
    private rl?;
    private nextId;
    private readonly pending;
    private closed;
    private stderrBuffer;
    private stderrBytes;
    /** Frames the server sent that were not valid JSON-RPC objects. */
    readonly protocolFaults: string[];
    /** Every method actually sent, for the "no thread/turn" evidence assertion. */
    readonly sentMethods: string[];
    constructor(options: CodexClientOptions);
    /** Whether the child is still running and not yet closed by this client. */
    get alive(): boolean;
    /** Start the child and complete the initialize handshake. */
    start(): Promise<{
        userAgent?: string;
        codexHome?: string;
        platformOs?: string;
    }>;
    /** The scrubbed tail of the child's stderr, for diagnostics only. */
    stderrTail(): string;
    /** Route one stdout line: a response to a pending request, or a notification. */
    private onLine;
    /** Handle one server notification; only exec output is meaningful here. */
    private onNotification;
    /** Reject every in-flight request; used when the child dies. */
    private failAll;
    /** Send one request and await its result, with a per-request timeout. */
    private request;
    /** Send one JSON-RPC notification (no response expected). */
    private notify;
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
    exec(request: CodexExecRequest): Promise<CodexExecResult>;
    /** Terminate one running processId. */
    terminate(processId: string): Promise<void>;
    /** Write stdin bytes to one running processId, optionally closing stdin. */
    write(processId: string, delta: string, closeStdin?: boolean): Promise<void>;
    /** Close the connection and stop the child, terminating any live processes. */
    close(): Promise<void>;
}

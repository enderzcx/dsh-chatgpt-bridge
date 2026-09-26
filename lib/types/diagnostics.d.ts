/** The observable phases of one call, in order. */
export type CallPhase = 'http_received' | 'handler_started' | 'handler_completed' | 'handler_failed';
export interface CallRecord {
    /** Server-generated correlation id, also returned to the caller. */
    correlation_id: string;
    /** ISO-8601 UTC. */
    at: string;
    /** Sequence within this process window. */
    seq: number;
    phase: CallPhase;
    /** A served MCP method, or `UNKNOWN_METHOD`. */
    method: string;
    /** A registered tool name, `UNREGISTERED`, or absent for non-tool methods. */
    tool?: string;
    /** Milliseconds since `http_received` for this call. */
    duration_ms: number;
    /** A known program code, or `UNKNOWN`. Never a message. */
    error_code?: string;
}
export interface DiagnosticsCoverage {
    /** When this process started recording. */
    since: string;
    /** Records currently retained. */
    retained: number;
    /** Ring capacity. */
    capacity: number;
    /** Records dropped because the ring was full. */
    dropped: number;
    /** Recording attempts that failed; the call itself was unaffected. */
    write_failures: number;
    /** Times an unrecognised error code was collapsed to `UNKNOWN`. */
    unknown_errors: number;
    /** Times an unrecognised tool name was collapsed to `UNREGISTERED`. */
    unknown_tools: number;
    /** Times an unrecognised method was collapsed to `UNKNOWN_METHOD`. */
    unknown_methods: number;
    /** Restart boundary for this in-memory window. */
    process_started_at: string;
    pid: number;
    /** True: in-memory only, cleared by a restart. */
    persistent: false;
}
export interface ToolSurfaceFingerprint {
    count: number;
    /** sha256 over the real tools/list JSON: names, descriptions, schemas, annotations. */
    sha256: string;
    /** Where the fingerprint came from, so it is never mistaken for a guess. */
    source: 'tools/list';
    computed_at: string;
}
export interface DiagnosticsSnapshot {
    coverage: DiagnosticsCoverage;
    /** Most recent records, newest last. */
    records: CallRecord[];
    /** Per-tool totals derived from the retained records. */
    totals: {
        tool: string;
        received: number;
        started: number;
        completed: number;
        failed: number;
    }[];
    /** Fingerprint of the advertised tool surface, when a server registered it. */
    tool_surface?: ToolSurfaceFingerprint;
}
export declare const UNREGISTERED_TOOL = "UNREGISTERED";
export declare const UNKNOWN_METHOD = "UNKNOWN_METHOD";
/** The correlation id of the call currently being handled, if any. */
export declare function currentCorrelationId(): string | undefined;
export declare class CallDiagnostics {
    private readonly capacity;
    private readonly ring;
    /** Registered tool names; the ONLY values accepted for `tool`. */
    private readonly knownTools;
    private seq;
    private dropped;
    private writeFailures;
    private unknownErrors;
    private unknownTools;
    private unknownMethods;
    private toolSurface?;
    private readonly startedAt;
    private readonly inFlight;
    /** JSON-RPC request id -> the correlation id minted for it at HTTP receipt. */
    private readonly byRequestId;
    constructor(capacity?: number);
    /** A fresh server-generated correlation id. Caller input is never used. */
    newCorrelationId(): string;
    /**
     * Establish the correlation context for one inbound HTTP message.
     *
     * Called once per received message, before the transport dispatches it, so
     * every later phase of that same call reads this id. Only the id this process
     * generated is stored: no header, and no caller-supplied string, is read.
     */
    enterRequest(correlationId: string): void;
    /**
     * Run one message's work inside its own correlation context.
     *
     * `enterWith` mutates the CURRENT chain, so calling it in a loop over a
     * JSON-RPC batch leaves only the last id visible. `run` scopes the store to the
     * callback and its async continuations, which is what gives each batch item its
     * own id. Batch items are dispatched sequentially by the transport, so one
     * shared context per item is sufficient and cannot leak between items.
     */
    runWithRequest<T>(correlationId: string, work: () => T): T;
    /** Adopt an id minted by {@link enterRequest}, or mint one as a fallback. */
    adoptOrMintCorrelationId(): string;
    /**
     * Bind the id minted at HTTP receipt to the JSON-RPC request id.
     *
     * A batch is dispatched by the transport as one unit, so the async context
     * cannot distinguish its messages; the request id can. The handler looks its
     * own id up by the request id it was called with, which is unambiguous even for
     * a batch.
     */
    bindRequestId(requestId: string | number, correlationId: string): void;
    /** The id bound to one JSON-RPC request id, if this process minted one. */
    correlationForRequestId(requestId: string | number | undefined): string | undefined;
    /** Declare a tool this process registered. Only these names are ever stored. */
    registerTool(name: string): void;
    /** Whether a tool name is one this process registered. */
    isKnownTool(name: unknown): name is string;
    /** Whether a method is one this listener serves. */
    isServedMethod(method: unknown): method is string;
    /**
     * Record one phase. Never throws, never blocks, never records caller data.
     * @returns the correlation id, so a later phase can reuse it.
     */
    record(input: {
        correlationId: string;
        phase: CallPhase;
        method: string;
        tool?: string;
        errorCode?: string;
    }): void;
    /** Note that an unknown error was collapsed to a fixed code. */
    noteUnknownError(): void;
    /**
     * Normalise any thrown value to an allowlisted code.
     *
     * The message is read only to choose between "argument validation" and
     * "other"; it is never stored, and an unrecognised `code` is not trusted even
     * when it looks like a code.
     */
    codeFor(error: unknown): string;
    /**
     * Record a fingerprint of the REAL tools/list payload.
     *
     * Callers pass what the MCP server would actually serve, so the hash covers
     * the JSON schema, descriptions and annotations a client sees — not a Zod
     * object or a hand-written summary.
     */
    setToolSurface(tools: readonly {
        name: string;
        title?: string | null;
        description?: string;
        inputSchema?: unknown;
        annotations?: unknown;
        execution?: unknown;
    }[]): ToolSurfaceFingerprint;
    /** The coverage window, so an absent record is never read as proof. */
    coverage(): DiagnosticsCoverage;
    /** A bounded snapshot plus per-tool totals derived from retained records. */
    snapshot(limit?: number): DiagnosticsSnapshot;
    /** Records for one correlation id, so a report can cite exact id spans. */
    byCorrelationId(correlationId: string): CallRecord[];
}
/** The process-wide registry; one coverage window per process. */
export declare const callDiagnostics: CallDiagnostics;

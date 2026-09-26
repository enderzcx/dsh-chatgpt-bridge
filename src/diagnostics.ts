/**
 * Bounded, secret-free call receipts for the MCP surface.
 *
 * Purpose: make it possible to answer "did this bridge receive that call, did a
 * handler start, and how did it end?" from local evidence, and to hand a support
 * report to a platform without exposing anything private.
 *
 * Hard rules, enforced by ALLOWLISTS rather than by inspecting string shape:
 *
 *   - `tool` is accepted only when it is a tool this process actually registered.
 *     Anything else is stored as `UNREGISTERED`.
 *   - `method` is accepted only when it is an MCP method this listener serves.
 *     Anything else is stored as `UNKNOWN_METHOD`.
 *   - `error_code` is accepted only when it is one of this program's own codes.
 *     Anything else is stored as `UNKNOWN`, and the unknown count is incremented.
 *   - A record contains a generated correlation id, UTC timestamps, the tool
 *     name, a phase, a duration, and that code. Nothing else.
 *   - Never recorded: tool arguments, file contents or paths, commands, prompts,
 *     session or message text, tokens, credentials, headers, raw HTTP, or error
 *     message text. A message is only ever pattern-matched to choose a fixed
 *     code; it is never stored.
 *
 * String-shape checks are deliberately NOT the guard: an uppercase regex would
 * happily accept a caller-supplied secret that happens to look like a code.
 *
 * Bounds and honest limits:
 *   - Fixed-size ring, in memory, PER PROCESS. It is NOT persistent logging: a
 *     restart empties it, and `coverage.process_started_at` states that boundary.
 *   - Drops and write failures are counted and disclosed, so "absent" is never
 *     silently read as "did not happen".
 *   - Recording never throws and never influences a call; a failure only
 *     increments a counter. Nothing is retried because of logging.
 *
 * What a record can and cannot prove:
 *   - `handler_started` means this bridge entered the handler.
 *   - `handler_completed` / `handler_failed` means the handler returned.
 *   - Absent means only "not observed within this coverage window". It does NOT
 *     prove the caller never sent the request, and it does not prove nothing was
 *     executed elsewhere.
 *   - An async start is recorded as a start, never as business completion.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { isKnownErrorCode, UNKNOWN_ERROR_CODE } from './error-codes.js';

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
  totals: { tool: string; received: number; started: number; completed: number; failed: number }[];
  /** Fingerprint of the advertised tool surface, when a server registered it. */
  tool_surface?: ToolSurfaceFingerprint;
}

export const UNREGISTERED_TOOL = 'UNREGISTERED';
export const UNKNOWN_METHOD = 'UNKNOWN_METHOD';

/** MCP methods this listener actually serves. */
const SERVED_METHODS: ReadonlySet<string> = new Set([
  'initialize',
  'notifications/initialized',
  'ping',
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/read',
  'prompts/list',
  'logging/setLevel',
  'completion/complete',
]);

const DEFAULT_CAPACITY = 512;

/**
 * Per-request correlation context.
 *
 * The HTTP receipt and the tool handler run on the same asynchronous chain, so
 * the receipt establishes the id here and the handler reads it back instead of
 * minting its own. Concurrent requests live on separate chains and therefore
 * cannot see each other's ids — correlation is by causality, not by a global
 * "current call" variable.
 */
interface RequestContext {
  correlationId: string;
  /** Tool name, once the handler knows it. */
  tool?: string;
}

const requestContext = new AsyncLocalStorage<RequestContext>();

/** The correlation id of the call currently being handled, if any. */
export function currentCorrelationId(): string | undefined {
  return requestContext.getStore()?.correlationId;
}

export class CallDiagnostics {
  private readonly capacity: number;
  private readonly ring: CallRecord[] = [];
  /** Registered tool names; the ONLY values accepted for `tool`. */
  private readonly knownTools = new Set<string>();
  private seq = 0;
  private dropped = 0;
  private writeFailures = 0;
  private unknownErrors = 0;
  private unknownTools = 0;
  private unknownMethods = 0;
  private toolSurface?: ToolSurfaceFingerprint;
  private readonly startedAt = new Date().toISOString();
  private readonly inFlight = new Map<string, { at: number; method: string; tool?: string }>();
  /** JSON-RPC request id -> the correlation id minted for it at HTTP receipt. */
  private readonly byRequestId = new Map<string, string>();

  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = Math.max(16, Math.trunc(capacity));
  }

  /** A fresh server-generated correlation id. Caller input is never used. */
  newCorrelationId(): string {
    return `call-${randomUUID()}`;
  }

  /**
   * Establish the correlation context for one inbound HTTP message.
   *
   * Called once per received message, before the transport dispatches it, so
   * every later phase of that same call reads this id. Only the id this process
   * generated is stored: no header, and no caller-supplied string, is read.
   */
  enterRequest(correlationId: string): void {
    requestContext.enterWith({ correlationId });
  }

  /**
   * Run one message's work inside its own correlation context.
   *
   * `enterWith` mutates the CURRENT chain, so calling it in a loop over a
   * JSON-RPC batch leaves only the last id visible. `run` scopes the store to the
   * callback and its async continuations, which is what gives each batch item its
   * own id. Batch items are dispatched sequentially by the transport, so one
   * shared context per item is sufficient and cannot leak between items.
   */
  runWithRequest<T>(correlationId: string, work: () => T): T {
    return requestContext.run({ correlationId }, work);
  }

  /** Adopt an id minted by {@link enterRequest}, or mint one as a fallback. */
  adoptOrMintCorrelationId(): string {
    return currentCorrelationId() ?? this.newCorrelationId();
  }

  /**
   * Bind the id minted at HTTP receipt to the JSON-RPC request id.
   *
   * A batch is dispatched by the transport as one unit, so the async context
   * cannot distinguish its messages; the request id can. The handler looks its
   * own id up by the request id it was called with, which is unambiguous even for
   * a batch.
   */
  bindRequestId(requestId: string | number, correlationId: string): void {
    const key = String(requestId);
    this.byRequestId.set(key, correlationId);
    // Bound the map so a long-lived process cannot grow it without limit.
    if (this.byRequestId.size > this.capacity) {
      const oldest = this.byRequestId.keys().next().value;
      if (oldest !== undefined) this.byRequestId.delete(oldest);
    }
  }

  /** The id bound to one JSON-RPC request id, if this process minted one. */
  correlationForRequestId(requestId: string | number | undefined): string | undefined {
    if (requestId === undefined) return undefined;
    return this.byRequestId.get(String(requestId));
  }

  /** Declare a tool this process registered. Only these names are ever stored. */
  registerTool(name: string): void {
    if (typeof name === 'string' && name.length > 0 && name.length <= 64) this.knownTools.add(name);
  }

  /** Whether a tool name is one this process registered. */
  isKnownTool(name: unknown): name is string {
    return typeof name === 'string' && this.knownTools.has(name);
  }

  /** Whether a method is one this listener serves. */
  isServedMethod(method: unknown): method is string {
    return typeof method === 'string' && SERVED_METHODS.has(method);
  }

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
  }): void {
    try {
      const now = Date.now();
      // Allowlist the method: a caller-supplied string is never stored.
      let method: string;
      if (this.isServedMethod(input.method)) {
        method = input.method;
      } else {
        this.unknownMethods += 1;
        method = UNKNOWN_METHOD;
      }
      // Allowlist the tool against what this process actually registered.
      let tool: string | undefined;
      if (input.tool !== undefined) {
        if (this.isKnownTool(input.tool)) {
          tool = input.tool;
        } else {
          this.unknownTools += 1;
          tool = UNREGISTERED_TOOL;
        }
      }
      // Allowlist the error code against this program's own vocabulary.
      let errorCode: string | undefined;
      if (input.errorCode !== undefined) {
        if (isKnownErrorCode(input.errorCode)) {
          errorCode = input.errorCode;
        } else {
          this.unknownErrors += 1;
          errorCode = UNKNOWN_ERROR_CODE;
        }
      }
      if (input.phase === 'http_received') {
        this.inFlight.set(input.correlationId, { at: now, method, ...(tool === undefined ? {} : { tool }) });
      }
      const state = this.inFlight.get(input.correlationId);
      const duration = state === undefined ? 0 : Math.max(0, now - state.at);
      const record: CallRecord = {
        correlation_id: input.correlationId,
        at: new Date(now).toISOString(),
        seq: ++this.seq,
        phase: input.phase,
        method,
        ...(tool === undefined ? {} : { tool }),
        duration_ms: duration,
        ...(errorCode === undefined ? {} : { error_code: errorCode }),
      };
      if (this.ring.length >= this.capacity) {
        this.ring.shift();
        this.dropped += 1;
      }
      this.ring.push(record);
      if (input.phase === 'handler_completed' || input.phase === 'handler_failed') {
        this.inFlight.delete(input.correlationId);
      }
      if (this.inFlight.size > this.capacity) {
        const oldest = [...this.inFlight.keys()][0];
        if (oldest !== undefined) this.inFlight.delete(oldest);
      }
    } catch {
      // Recording must never affect a call. Disclose the failure instead.
      this.writeFailures += 1;
    }
  }

  /** Note that an unknown error was collapsed to a fixed code. */
  noteUnknownError(): void {
    this.unknownErrors += 1;
  }

  /**
   * Normalise any thrown value to an allowlisted code.
   *
   * The message is read only to choose between "argument validation" and
   * "other"; it is never stored, and an unrecognised `code` is not trusted even
   * when it looks like a code.
   */
  codeFor(error: unknown): string {
    try {
      if (error !== null && typeof error === 'object' && 'code' in error) {
        const code = (error as { code?: unknown }).code;
        if (isKnownErrorCode(code)) return code;
        this.noteUnknownError();
        return UNKNOWN_ERROR_CODE;
      }
      const message = error instanceof Error ? error.message : '';
      if (/invalid|validation|expected|required/i.test(message)) return 'INVALID_ARGUMENTS';
      this.noteUnknownError();
      return 'INTERNAL';
    } catch {
      return 'INTERNAL';
    }
  }

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
  }[]): ToolSurfaceFingerprint {
    // Mirror the SDK's own wire conversion (same helper, same options), so this
    // hashes the JSON Schema a client actually receives. The registered object
    // holds a Zod schema, and hashing that would fingerprint Zod internals
    // rather than the advertised contract.
    const material = [...tools]
      .map((tool) => canonicalJson({
        name: tool.name,
        title: tool.title ?? null,
        description: tool.description ?? '',
        // Mirror the SDK's own advertised shape, including the fields it adds
        // beyond the registered config, so this hash equals the wire payload.
        inputSchema: toWireJsonSchema(tool.inputSchema),
        annotations: tool.annotations ?? null,
        execution: tool.execution ?? null,
      }))
      .sort();
    const fingerprint: ToolSurfaceFingerprint = {
      count: tools.length,
      sha256: createHash('sha256').update(material.join('\n')).digest('hex'),
      source: 'tools/list',
      computed_at: new Date().toISOString(),
    };
    this.toolSurface = fingerprint;
    return fingerprint;
  }

  /** The coverage window, so an absent record is never read as proof. */
  coverage(): DiagnosticsCoverage {
    return {
      since: this.startedAt,
      retained: this.ring.length,
      capacity: this.capacity,
      dropped: this.dropped,
      write_failures: this.writeFailures,
      unknown_errors: this.unknownErrors,
      unknown_tools: this.unknownTools,
      unknown_methods: this.unknownMethods,
      process_started_at: this.startedAt,
      pid: process.pid,
      persistent: false,
    };
  }

  /** A bounded snapshot plus per-tool totals derived from retained records. */
  snapshot(limit = 100): DiagnosticsSnapshot {
    const max = Math.max(1, Math.min(Math.trunc(limit), this.capacity));
    const records = this.ring.slice(-max);
    const totals = new Map<string, { tool: string; received: number; started: number; completed: number; failed: number }>();
    for (const record of this.ring) {
      if (record.tool === undefined) continue;
      const entry = totals.get(record.tool)
        ?? { tool: record.tool, received: 0, started: 0, completed: 0, failed: 0 };
      if (record.phase === 'http_received') entry.received += 1;
      else if (record.phase === 'handler_started') entry.started += 1;
      else if (record.phase === 'handler_completed') entry.completed += 1;
      else entry.failed += 1;
      totals.set(record.tool, entry);
    }
    return {
      coverage: this.coverage(),
      records,
      totals: [...totals.values()].sort((a, b) => a.tool.localeCompare(b.tool)),
      ...(this.toolSurface === undefined ? {} : { tool_surface: this.toolSurface }),
    };
  }

  /** Records for one correlation id, so a report can cite exact id spans. */
  byCorrelationId(correlationId: string): CallRecord[] {
    return this.ring.filter((record) => record.correlation_id === correlationId);
  }
}

/**
 * Canonical JSON for hashing: object keys sorted recursively.
 *
 * Two equal JSON values can differ in key order depending on the code path that
 * built them, so the fingerprint sorts keys before hashing. Otherwise the hash
 * would depend on construction order rather than on the advertised contract.
 */
function canonicalJson(value: unknown): string {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(node as Record<string, unknown>).sort()) {
        out[key] = walk((node as Record<string, unknown>)[key]);
      }
      return out;
    }
    return node;
  };
  return JSON.stringify(walk(value));
}

/** Convert one registered schema to the JSON Schema form the SDK advertises. */
function toWireJsonSchema(inputSchema: unknown): unknown {
  try {
    const object = normalizeObjectSchema(inputSchema as never);
    if (object === undefined || object === null) return {};
    return toJsonSchemaCompat(object as never, { strictUnions: true, pipeStrategy: 'input' });
  } catch {
    // Never let an unconvertible schema break the fingerprint or the server.
    return {};
  }
}

/** The process-wide registry; one coverage window per process. */
export const callDiagnostics = new CallDiagnostics(
  Number(process.env.DSH_CHATGPT_BRIDGE_CALL_LOG_CAPACITY ?? '') > 0
    ? Number(process.env.DSH_CHATGPT_BRIDGE_CALL_LOG_CAPACITY)
    : undefined,
);

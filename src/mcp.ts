/**
 * MCP server surface.
 *
 * Two families share this endpoint so ChatGPT needs one connection:
 *
 *   1. Agent-control tools (dsh_*) — these drive real DSH sessions, agents,
 *      goals and approvals. They consume model reasoning and are the only way
 *      to reach DSH internals.
 *   2. Direct-operation tools (dsh_read_text_file, dsh_write_text_file,
 *      dsh_edit_text_file, dsh_run_command, dsh_operator_*) — these run
 *      locally in this process against the trusted direct-ops policy. They
 *      create no session, invoke no agent and consume no model turn.
 *
 * Outputs are JSON text blocks; failures are reported as isError results with
 * { error: { code, message } }.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { callDiagnostics } from './diagnostics.js';
import { z } from 'zod';
import { Bridge, BridgeError } from './bridge.js';
import type { ResolvedBridgeConfig } from './config.js';
import type { BridgeLogger } from './log.js';
import { redactValue } from './redact.js';
import { parseConstraints } from './goal-constraints.js';
import { BRIDGE_NAME, BRIDGE_VERSION } from './version.js';
import { registerDirectOpsTools, type DirectOpsRuntime } from './direct/tools.js';

const actionClassSchema = z.enum([
  'filesystem.read',
  'filesystem.write',
  'filesystem.scan',
  'process.exec',
  'process.spawn',
  'git.read',
  'git.mutate',
  'npm.publish',
  'github.release',
  'network',
  'credentials.metadata',
  'workspace.read',
  'workspace.write',
  'temp.read',
  'temp.write',
  'external_path.read',
  'external_path.write',
]);

const constraintSchema = z.object({
  read_only: z.boolean().optional(),
  allow_workspace_scan: z.boolean().optional(),
  max_changed_files: z.number().int().min(0).optional(),
  allowed_actions: z.array(actionClassSchema).optional(),
  forbidden_actions: z.array(actionClassSchema).optional(),
});

function textResult(value: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(redactValue(value), null, 2) }] };
}

function errorResult(error: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  if (error instanceof BridgeError) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } }, null, 2) }],
      isError: true,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const stack = process.env.DSH_CHATGPT_BRIDGE_DEBUG === '1' && error instanceof Error ? error.stack : undefined;
  return {
    content: [{ type: 'text', text: JSON.stringify(stack ? { error: { code: 'INTERNAL', message, stack } } : { error: { code: 'INTERNAL', message } }, null, 2) }],
    isError: true,
  };
}

/** Wrap one async handler into the MCP error convention. */
function safe<A>(handler: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<{ content: { type: 'text'; text: string }[]; isError?: true }> => {
    try {
      return textResult(await handler(args));
    } catch (error) {
      return errorResult(error);
    }
  };
}

/**
 * MCP tool annotations, chosen per tool from what the tool can actually cause.
 *
 * These describe REACHABLE behaviour, including indirect effects. A tool that
 * "only appends to a queue" is not benign when the agent then executes it: the
 * reachable effect is whatever the agent does, which includes overwriting and
 * deleting files, network calls and other external actions. The vocabulary below
 * therefore classifies by the worst outcome reachable through the tool, not by
 * how small its own code looks.
 *
 *   readOnlyHint    - the call mutates no state at all, local or remote.
 *   destructiveHint - the call can remove, overwrite, cancel, stop or otherwise
 *                     cause loss, either directly or by releasing execution.
 *   idempotentHint  - a REPEATED call has no further effect. This is about side
 *                     effects, not about whether the returned value is stable:
 *                     a read that reports changing progress is still idempotent,
 *                     while a wait that advances an internal cursor is not.
 *   openWorldHint   - the call reaches open, externally-controlled space: the
 *                     public network, third-party services, or an executing agent
 *                     whose tool set can do so. Merely calling out of the current
 *                     process (a local app-server, a local socket) is NOT open
 *                     world on its own.
 */
interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/**
 * Pure inspection of local state. Repeating it changes nothing, so it is
 * idempotent even though the values it reports may move between calls.
 */
const A_PURE_READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/**
 * A local-state write that can neither destroy anything nor start execution:
 * queue reordering and pausing.
 */
const A_LOCAL_WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/**
 * A local-state write that destroys something: cancelling, stopping, clearing a
 * queue, overwriting or removing a queued message, reloading policy.
 *
 * Not open-world: the blast radius is this host and this bridge.
 */
const A_LOCAL_DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
/**
 * Drives the agent: delivering a prompt, answering a question, approving a
 * parked call, starting/revising/resuming a goal, or re-dispatching a step.
 *
 * Destructive AND open-world, because the reachable effect is one full agent
 * turn with its whole tool set — file overwrite and deletion, and network or
 * other external actions. Marking these non-destructive because the bridge's own
 * code only "appends a message" would understate what the call can cause.
 */
const A_DRIVES_AGENT: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
/**
 * Observes a running goal over time. It is not read-only (it advances progress
 * cursors, writes the Goal store, releases the workspace lock and, on a terminal
 * goal, deletes goal-owned temp resources) and it observes an agent that can act
 * externally, so it is destructive and open-world as well.
 */
const A_WAITS_ON_AGENT: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

/**
 * Instrument every tool registration with call receipts.
 *
 * Wrapping the registration entry point (instead of the SDK or each handler) is
 * the smallest seam that covers the whole surface: names, schemas, annotations
 * and handler return values are untouched, so the tool contract is identical.
 * Only an extra top-level `correlation_id` is added to each result, which lets a
 * support report tie one platform-visible call to local phases.
 */
type ToolHandler = (...args: unknown[]) => unknown;
type RegisterTool = (name: string, config: unknown, handler: ToolHandler) => unknown;

function instrumentRegistrations(server: McpServer): void {
  const target = server as unknown as { registerTool: RegisterTool };
  const original = target.registerTool.bind(server);
  target.registerTool = (name: string, config: unknown, handler: ToolHandler): unknown => {
    if (typeof handler !== 'function') return original(name, config, handler);
    // Declare the name so diagnostics will accept it; anything not declared here
    // is stored as UNREGISTERED rather than trusted.
    callDiagnostics.registerTool(name);
    const wrapped: ToolHandler = async (...args: unknown[]): Promise<unknown> => {
      // Prefer the id bound to THIS request's JSON-RPC id. In a batch the async
      // context covers every message of the dispatch, but the request id does
      // not, so this is what keeps a batch from collapsing onto one id. The
      // context lookup is the fallback, and minting is the last resort for an
      // in-process call with no HTTP layer.
      const extra = args.length > 1
        ? args[1] as { requestId?: string | number } | undefined
        : undefined;
      const correlationId = callDiagnostics.correlationForRequestId(extra?.requestId)
        ?? callDiagnostics.adoptOrMintCorrelationId();
      callDiagnostics.record({ correlationId, phase: 'handler_started', method: 'tools/call', tool: name });
      try {
        const result = await handler(...args);
        const failed = result !== null && typeof result === 'object' && (result as { isError?: unknown }).isError === true;
        // A tool that starts asynchronous work reports a start, never business
        // completion: `handler_completed` means the handler returned, nothing more.
        callDiagnostics.record({
          correlationId,
          phase: failed ? 'handler_failed' : 'handler_completed',
          method: 'tools/call',
          tool: name,
          ...(failed ? { errorCode: errorCodeOfResult(result) } : {}),
        });
        if (result === null || typeof result !== 'object') return result;
        // `_meta` is the standard extension channel and survives a client's
        // result-schema parse (ResultSchema is a loose object); the top-level
        // `correlation_id` is kept for readers that only look at fields.
        const shaped = result as Record<string, unknown>;
        const existingMeta = shaped._meta !== null && typeof shaped._meta === 'object'
          ? shaped._meta as Record<string, unknown>
          : {};
        return {
          ...shaped,
          correlation_id: correlationId,
          _meta: { ...existingMeta, 'dsh/correlation_id': correlationId },
        };
      } catch (error) {
        callDiagnostics.record({
          correlationId,
          phase: 'handler_failed',
          method: 'tools/call',
          tool: name,
          errorCode: callDiagnostics.codeFor(error),
        });
        throw error;
      }
    };
    return original(name, config, wrapped);
  };
}

/** Read the stable code out of an already-built tool error result. */
function errorCodeOfResult(result: unknown): string {
  try {
    const content = (result as { content?: unknown }).content;
    if (!Array.isArray(content) || content.length === 0) return 'INTERNAL';
    const text = (content[0] as { text?: unknown }).text;
    if (typeof text !== 'string') return 'INTERNAL';
    const parsed = JSON.parse(text) as { error?: { code?: unknown } };
    const code = parsed.error?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,48}$/.test(code) ? code : 'INTERNAL';
  } catch {
    return 'INTERNAL';
  }
}

/** Fingerprint the JSON tool surface this server advertises. */
function registerToolSurfaceFingerprint(server: McpServer): void {
  try {
    const registered = (server as unknown as {
      _registeredTools?: Record<string, {
        title?: string;
        description?: string;
        inputSchema?: unknown;
        annotations?: unknown;
        execution?: unknown;
      }>;
    })._registeredTools;
    if (registered === undefined) return;
    callDiagnostics.setToolSurface(Object.entries(registered).map(([name, tool]) => ({
      name,
      title: tool.title ?? null,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema ?? null,
      annotations: tool.annotations ?? null,
      execution: tool.execution ?? null,
    })));
  } catch {
    // A fingerprint is diagnostic only; never fail server construction for it.
  }
}

export function createMcpServer(
  bridge: Bridge,
  cfg: ResolvedBridgeConfig,
  log: BridgeLogger,
  directOps?: DirectOpsRuntime,
): McpServer {
  const server = new McpServer(
    { name: BRIDGE_NAME, version: BRIDGE_VERSION },
    { capabilities: { tools: {} } },
  );
  instrumentRegistrations(server);

  server.registerTool(
    'dsh_health',
    {
      title: 'DSH bridge health',
      description:
        'Bridge and DSH runtime status: versions, live/persisted/active session counts and ' +
        'capability flags. Never returns tokens, keys, cookies or environment secrets.',
      inputSchema: z.object({}),
      annotations: A_PURE_READ,
    },
    safe(async () => {
      // Diagnostics are process-local and independent of bridge state, so a
      // bridge failure must not hide them; a failure is reported as a fixed code.
      let base: Record<string, unknown>;
      try {
        base = typeof (bridge as { health?: unknown }).health === 'function'
          ? { ...(await bridge.health() as unknown as Record<string, unknown>) }
          : { status: 'unknown', note: 'bridge health is unavailable in this composition' };
      } catch (error) {
        base = { status: 'error', error_code: callDiagnostics.codeFor(error) };
      }
      // Bounded, secret-free call receipts for THIS process. In-memory only: a
      // restart starts a new window, which `coverage.process_started_at` states.
      // An absent record means "not observed in this window", never "the caller
      // did not send it" and never "nothing executed elsewhere".
      const snapshot = callDiagnostics.snapshot(40);
      return {
        ...base,
        call_diagnostics: {
          coverage: snapshot.coverage,
          ...(snapshot.tool_surface === undefined ? {} : { tool_surface: snapshot.tool_surface }),
          totals: snapshot.totals,
          recent: snapshot.records,
        },
      };
    }),
  );

  server.registerTool(
    'dsh_list_workspaces',
    {
      title: 'List registered workspaces',
      description:
        'List the workspaces DSH already registered/authorized. Sessions can only be created ' +
        'inside these. Arbitrary paths are never opened or auto-registered.',
      inputSchema: z.object({}),
      annotations: A_PURE_READ,
    },
    safe(async () => bridge.listWorkspaces()),
  );

  server.registerTool(
    'dsh_create_session',
    {
      title: 'Create a DSH session',
      description:
        'Create a real DSH agent session bound to a registered workspace (id, canonical path, or ' +
        'title from dsh_list_workspaces). DSH begins working locally at once; if initial_message is ' +
        'given the first turn begins right away. Returns the stable session_id to continue later.',
      inputSchema: z.object({
        workspace: z.string().min(1).describe('Workspace id, path, or title from dsh_list_workspaces'),
        title: z.string().optional().describe('Optional display title for the session'),
        initial_message: z.string().optional().describe('Optional first message for the agent'),
      }),
      annotations: A_DRIVES_AGENT,
    },
    safe(async (args: { workspace: string; title?: string; initial_message?: string }) =>
      bridge.createSession(args.workspace, args.title, args.initial_message)),
  );

  server.registerTool(
    'dsh_list_sessions',
    {
      title: 'List DSH sessions',
      description:
        'List sessions (live + persisted), newest first, with limited paging. DSH persistence is ' +
        'the authority: sessions survive bridge and ChatGPT restarts and can be continued by id.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional().describe('Max rows (default 50)'),
        offset: z.number().int().min(0).optional().describe('Skip this many rows (default 0)'),
        workspace: z.string().optional().describe('Filter to one registered workspace'),
      }),
      annotations: A_PURE_READ,
    },
    safe(async (args: { limit?: number; offset?: number; workspace?: string }) =>
      bridge.listSessions({ limit: args.limit, offset: args.offset, workspace: args.workspace })),
  );

  server.registerTool(
    'dsh_get_session',
    {
      title: 'Inspect one DSH session',
      description:
        'Status, workspace, recent message summary (bounded), agent state, pending work, ' +
        'waiting approvals/questions and todos for one session. History is budgeted, never unlimited.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        max_items: z.number().int().min(1).max(200).optional().describe('Max message rows'),
        max_chars: z.number().int().min(100).max(100000).optional().describe('Max chars per message'),
      }),
      annotations: A_PURE_READ,
    },
    safe(async (args: { session_id: string; max_items?: number; max_chars?: number }) =>
      bridge.getSession(args.session_id, args.max_items, args.max_chars)),
  );

  server.registerTool(
    'dsh_send_message',
    {
      title: 'Send a message to a DSH session',
      description:
        'Continue an EXISTING DSH session through the same agent loop (never a fresh agent). ' +
        'delivery="followup" (default) queues the message as its own next turn; delivery="steer" ' +
        'feeds it to the running agent at its nearest step boundary. Returns the real queue state ' +
        'plus the message_id: "queued" only means DSH accepted it into the pending inbox, not that ' +
        'the model has read it. Use dsh_list_pending_messages for ids and dsh_*_pending_message to ' +
        'reposition, edit or withdraw one before it is claimed. For a multi-step goal or execution ' +
        'plan prefer dsh_start_goal + dsh_wait_goal instead of polling this low-level API.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        message: z.string().min(1).max(20000),
        delivery: z
          .enum(['followup', 'steer'])
          .optional()
          .describe('followup (default) queues its own next turn; steer is consumed at the nearest step boundary'),
      }),
      annotations: A_DRIVES_AGENT,
    },
    safe(async (args: { session_id: string; message: string; delivery?: 'followup' | 'steer' }) =>
      bridge.deliverMessage(args.session_id, args.message, args.delivery ?? 'followup')),
  );

  server.registerTool(
    'dsh_list_pending_messages',
    {
      title: 'List a session\'s pending inbox messages',
      description:
        'List the messages DSH has accepted but not yet claimed, with the stable message_id and ' +
        'content version needed to manage them. next_step entries are consumed at the nearest step ' +
        'boundary; next_turn entries each start their own turn. Returns in claim order. Read-only: ' +
        'a cold session is read from its durable log and is never woken or resumed.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        max_chars: z.number().int().min(40).max(20000).optional().describe('Max chars per message'),
      }),
      annotations: A_PURE_READ,
    },
    safe(async (args: { session_id: string; max_chars?: number }) =>
      bridge.listPendingMessages(args.session_id, args.max_chars)),
  );

  server.registerTool(
    'dsh_promote_pending_message',
    {
      title: 'Steer a running turn with an already-queued message',
      description:
        'Move one message that is still queued for a LATER turn into the current turn as steering, ' +
        'using DSH\'s own queue rule: the item must still be in next_turn and the agent must be ' +
        'running. The same message object is removed and re-delivered through agent.steer, so it is ' +
        'never copied, DSH handles wake and cancellation, and repeated promotions keep their order. ' +
        'Send expected_version (from dsh_list_pending_messages) to refuse overwriting a message that ' +
        'another client changed. Refuses with MESSAGE_NOT_PROMOTABLE, STEER_UNAVAILABLE, ' +
        'MESSAGE_VERSION_CONFLICT, MESSAGE_ALREADY_ADMITTED, MESSAGE_NOT_PENDING, MESSAGE_ID_UNKNOWN ' +
        'or GOAL_MESSAGE_PROTECTED instead of guessing.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        message_id: z.string().min(1),
        expected_version: z.string().min(1).optional().describe('Content version from dsh_list_pending_messages'),
      }),
      annotations: A_LOCAL_WRITE,
    },
    safe(async (args: { session_id: string; message_id: string; expected_version?: string }) =>
      bridge.promotePendingMessage(args.session_id, args.message_id, args.expected_version)),
  );

  server.registerTool(
    'dsh_edit_pending_message',
    {
      title: 'Edit a queued message before it is claimed',
      description:
        'Replace the text of one still-pending message while preserving its identity, so anything ' +
        'already tracking that message_id keeps working and nothing is delivered twice. Only text ' +
        'content is editable: a message carrying attachments or non-text blocks is refused with ' +
        'MESSAGE_EDIT_NON_TEXT rather than silently losing that data. Pass expected_version to refuse ' +
        'overwriting a change made by another client (MESSAGE_VERSION_CONFLICT).',
      inputSchema: z.object({
        session_id: z.string().min(1),
        message_id: z.string().min(1),
        message: z.string().min(1).max(20000),
        expected_version: z.string().min(1).optional().describe('Content version from dsh_list_pending_messages'),
      }),
      annotations: A_LOCAL_DESTRUCTIVE,
    },
    safe(async (args: { session_id: string; message_id: string; message: string; expected_version?: string }) =>
      bridge.editPendingMessage(args.session_id, args.message_id, args.message, args.expected_version)),
  );

  server.registerTool(
    'dsh_withdraw_pending_message',
    {
      title: 'Withdraw a queued message',
      description:
        'Remove one still-pending message from the queue without cancelling the active turn. Use ' +
        'dsh_cancel_task only when the in-flight turn itself must stop; cancellation also discards ' +
        'every pending message. Pass expected_version to refuse withdrawing a message another client ' +
        'changed. A supervised-Goal control message is refused with GOAL_MESSAGE_PROTECTED.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        message_id: z.string().min(1),
        expected_version: z.string().min(1).optional().describe('Content version from dsh_list_pending_messages'),
      }),
      annotations: A_LOCAL_DESTRUCTIVE,
    },
    safe(async (args: { session_id: string; message_id: string; expected_version?: string }) =>
      bridge.withdrawPendingMessage(args.session_id, args.message_id, args.expected_version)),
  );

  server.registerTool(
    'dsh_get_task_status',
    {
      title: 'Task status of one session',
      description:
        'Status vocabulary: idle, queued, running, waiting_for_user, waiting_for_approval, ' +
        'completed, failed, cancelled, blocked, max-tokens, interrupted. Also reports pending ' +
        'inbox items and any waiting approvals/questions with their ids. For long supervised ' +
        'goals prefer dsh_wait_goal, which long-polls instead of returning one snapshot.',
      inputSchema: z.object({ session_id: z.string().min(1) }),
      annotations: A_PURE_READ,
    },
    safe(async (args: { session_id: string }) => bridge.getTaskStatus(args.session_id)),
  );

  server.registerTool(
    'dsh_get_result',
    {
      title: 'Final result of the last turn',
      description:
        'Last turn\'s assistant text, status, tool calls, changed files (from the session log, ' +
        'not guessed) and structured error when the turn failed. dsh_wait_goal already returns a ' +
        'bounded final summary when the goal is terminal; use this for a more detailed check.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        max_chars: z.number().int().min(100).max(100000).optional().describe('Max chars of assistant text'),
      }),
      annotations: A_PURE_READ,
    },
    safe(async (args: { session_id: string; max_chars?: number }) =>
      bridge.getResult(args.session_id, args.max_chars)),
  );

  server.registerTool(
    'dsh_cancel_task',
    {
      title: 'Cancel the running task',
      description:
        'Cancel the active turn of a live session through DSH\'s own cancel mechanism ' +
        '(agent.cancel). No processes are killed; the turn ends with an aborted reason. For ' +
        'supervised goals prefer dsh_stop_goal, which is idempotent and also fails-closed any ' +
        'pending approval or question.',
      inputSchema: z.object({ session_id: z.string().min(1) }),
      annotations: A_LOCAL_DESTRUCTIVE,
    },
    safe(async (args: { session_id: string }) => bridge.cancelTask(args.session_id)),
  );

  server.registerTool(
    'dsh_answer_question',
    {
      title: 'Answer a pending user question',
      description:
        'Answer a question the DSH agent asked the human (status waiting_for_user). Pass the ' +
        'question_id from dsh_get_task_status, one or more offered option labels, and optional ' +
        'free text.',
      inputSchema: z.object({
        question_id: z.string().min(1),
        session_id: z.string().optional(),
        selected: z.array(z.string()).default([]),
        custom: z.string().optional(),
      }),
      annotations: A_DRIVES_AGENT,
    },
    safe(async (args: { question_id: string; session_id?: string; selected: string[]; custom?: string }) =>
      bridge.answerQuestion(args.question_id, args.session_id, { selected: args.selected, custom: args.custom })),
  );

  server.registerTool(
    'dsh_approve',
    {
      title: 'Decide one pending approval',
      description:
        'Decide one explicit DSH permission approval (status waiting_for_approval). Requires the ' +
        'exact approval_id and an explicit approve/reject decision. There is no approve-all; ' +
        'every grant is allowed-once for the exact tool call. Rejecting fails the call closed.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        approval_id: z.string().min(1),
        decision: z.enum(['approve', 'reject']),
      }),
      annotations: A_DRIVES_AGENT,
    },
    safe(async (args: { session_id: string; approval_id: string; decision: 'approve' | 'reject' }) =>
      bridge.approve(args.session_id, args.approval_id, args.decision)),
  );

  server.registerTool(
    'dsh_create_goal',
    {
      title: 'Create a supervised DSH goal',
      description:
        'Create a supervised DSH goal. If an equivalent active Goal already exists on the workspace, ' +
        'it is reused idempotently without bumping revision. Returns continuation_required.',
      inputSchema: z.object({
        workspace: z.string().min(1).describe('Workspace id, path, or title from dsh_list_workspaces'),
        goal: z.string().min(1).max(20000).describe('The completion target for DSH'),
        plan: z.string().max(20000).optional().describe('Optional execution plan DSH should follow'),
        request_id: z.string().min(1).max(200).optional().describe('Idempotency key'),
        execution_mode: z.enum(['standard', 'minimal', 'strict']).optional(),
        constraints: constraintSchema.optional(),
        workspace_lock_override: z.boolean().optional()
          .describe('Take over an existing mutable workspace lock. Concurrent writers are rejected by default.'),
      }),
      annotations: A_DRIVES_AGENT,
    },
    safe(async (args: {
      workspace: string;
      goal: string;
      plan?: string;
      request_id?: string;
      execution_mode?: 'standard' | 'minimal' | 'strict';
      constraints?: unknown;
      workspace_lock_override?: boolean;
    }) => bridge.createGoal({ ...args, constraints: parseConstraints(args.constraints) })),
  );

  server.registerTool(
    'dsh_revise_goal',
    {
      title: 'Revise a supervised DSH goal',
      description:
        'Substantive update to an existing Goal (goal/plan/mode/constraints). Increments revision with optimistic locking (expected_revision).',
      inputSchema: z.object({
        session_id: z.string().min(1),
        goal: z.string().max(20000).optional(),
        plan: z.string().max(20000).optional(),
        expected_revision: z.number().int().min(1).optional().describe('Optimistic lock on current Goal revision'),
        execution_mode: z.enum(['standard', 'minimal', 'strict']).optional(),
        constraints: constraintSchema.optional(),
        revision_reason: z.string().max(200).optional(),
        request_id: z.string().min(1).max(200).optional(),
        workspace_lock_override: z.boolean().optional().describe('Take over an existing mutable workspace lock.'),
      }),
      annotations: A_DRIVES_AGENT,
    },
    safe(async (args: {
      session_id: string;
      goal?: string;
      plan?: string;
      expected_revision?: number;
      execution_mode?: 'standard' | 'minimal' | 'strict';
      constraints?: unknown;
      revision_reason?: string;
      request_id?: string;
      workspace_lock_override?: boolean;
    }) => bridge.reviseGoal({ ...args, constraints: parseConstraints(args.constraints) })),
  );

  server.registerTool(
    'dsh_pause_goal',
    {
      title: 'Pause a supervised DSH goal',
      description: 'Pause active turn and keep durable checkpoint without losing state.',
      inputSchema: z.object({ session_id: z.string().min(1) }),
      annotations: A_LOCAL_WRITE,
    },
    safe(async (args: { session_id: string }) => bridge.pauseGoal(args.session_id)),
  );

  server.registerTool(
    'dsh_resume_goal',
    {
      title: 'Resume a paused/deferred DSH goal',
      description: 'Resume from checkpoint without re-running completed steps.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        resume_steps: z.array(z.string().min(1)).optional(),
        request_id: z.string().min(1).max(200).optional(),
        workspace_lock_override: z.boolean().optional().describe('Take over an existing mutable workspace lock.'),
      }),
      annotations: A_DRIVES_AGENT,
    },
    safe(async (args: {
      session_id: string;
      resume_steps?: string[];
      request_id?: string;
      workspace_lock_override?: boolean;
    }) => bridge.resumeGoal(args.session_id, args.resume_steps, args.request_id, args.workspace_lock_override)),
  );

  server.registerTool(
    'dsh_retry_step',
    {
      title: 'Retry a blocked or failed step',
      description: 'Retry a specific blocked or failed step under the same identity, clearing stale blockers.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        step_id: z.string().min(1),
        request_id: z.string().min(1).max(200).optional(),
        workspace_lock_override: z.boolean().optional().describe('Take over an existing mutable workspace lock.'),
      }),
      annotations: A_DRIVES_AGENT,
    },
    safe(async (args: {
      session_id: string;
      step_id: string;
      request_id?: string;
      workspace_lock_override?: boolean;
    }) => bridge.retryStep(args.session_id, args.step_id, args.request_id, args.workspace_lock_override)),
  );

  server.registerTool(
    'dsh_rerun_step',
    {
      title: 'Rerun or re-verify a step',
      description: 'Explicitly rerun a step with a fresh attempt even if previously completed.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        step_id: z.string().min(1),
        request_id: z.string().min(1).max(200).optional(),
        workspace_lock_override: z.boolean().optional().describe('Take over an existing mutable workspace lock.'),
      }),
      annotations: A_DRIVES_AGENT,
    },
    safe(async (args: {
      session_id: string;
      step_id: string;
      request_id?: string;
      workspace_lock_override?: boolean;
    }) => bridge.rerunStep(args.session_id, args.step_id, args.request_id, args.workspace_lock_override)),
  );

  server.registerTool(
    'dsh_wait_until_action_required',
    {
      title: 'Long wait on supervised Goal until action is required',
      description:
        'Server-side long wait: returns only when human approval/question, error, or terminal completion is reached, avoiding high-frequency polling.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        wait_seconds: z.number().int().min(1).max(300).optional().describe('Max seconds to wait (default 120, max 300)'),
      }),
      annotations: A_WAITS_ON_AGENT,
    },
    safe(async (args: { session_id: string; wait_seconds?: number }) =>
      bridge.waitUntilActionRequired(args.session_id, args.wait_seconds)),
  );

  server.registerTool(
    'dsh_credential_status',
    {
      title: 'Check credential availability (secret-safe)',
      description: 'Inspect provider credential availability and source without returning raw secret tokens or keys.',
      inputSchema: z.object({}),
      annotations: A_PURE_READ,
    },
    safe(async () => bridge.getCredentialStatus()),
  );

  server.registerTool(
    'dsh_start_goal',
    {
      title: 'Start a supervised DSH goal',
      description:
        'Creates or continues a supervised DSH Goal for multi-step work: it opens (or reuses) a ' +
        'native DSH session and delivers the goal and plan to it as a user message. DSH then ' +
        'executes locally with its own tools and permissions. Effects: writes to the session log, ' +
        'may lock the workspace, and may cause file, command and network activity through the ' +
        'agent. Returns the current status plus continuation_required and next_tool_call, which ' +
        'state whether observable work is still in flight and which read tool observes it. ' +
        'Optional request_id makes connector retries idempotent. Passing session_id revises the ' +
        'existing Goal (revision +1, history kept); dsh_update_goal defers or resumes steps ' +
        'without rewriting it. execution_mode defaults to standard; constraints only tighten ' +
        'DSH permissions.',
      inputSchema: z.object({
        workspace: z.string().min(1).describe('Workspace id, path, or title from dsh_list_workspaces'),
        goal: z.string().min(1).max(20000).describe('The completion target for DSH'),
        plan: z.string().max(20000).optional().describe('Optional execution plan DSH should follow'),
        session_id: z.string().optional().describe('Continue this existing DSH session; omit to create a new one'),
        request_id: z.string().min(1).max(200).optional().describe('Idempotency key for connector retries in this process'),
        expected_revision: z.number().int().min(1).optional().describe('Optional optimistic lock on current Goal revision'),
        execution_mode: z.enum(['standard', 'minimal', 'strict']).optional()
          .describe('standard (default), minimal (necessary actions only), or strict (follow plan/constraints)'),
        constraints: constraintSchema.optional().describe('Structured Goal constraints; can only tighten DSH policy'),
        workspace_lock_override: z.boolean().optional()
          .describe('Take over an existing mutable workspace lock. Concurrent writers are rejected by default.'),
      }),
      annotations: A_DRIVES_AGENT,
    },
    safe(async (args: {
      workspace: string;
      goal: string;
      plan?: string;
      session_id?: string;
      request_id?: string;
      expected_revision?: number;
      execution_mode?: 'standard' | 'minimal' | 'strict';
      constraints?: unknown;
      workspace_lock_override?: boolean;
    }) => bridge.startGoal({ ...args, constraints: parseConstraints(args.constraints) })),
  );

  server.registerTool(
    'dsh_update_goal',
    {
      title: 'Revise, defer, or resume a supervised Goal',
      description:
        'Control-plane update for an EXISTING supervised Goal. session_id is required and this '
        + 'tool never creates a session. Effects: writes the Goal record and delivers a control '
        + 'message to the session, so it can release blocked work back to the agent. '
        + 'action=revise changes goal/plan/mode/constraints; action=defer marks steps deferred '
        + '(not failed) so independent branches can continue; action=resume reactivates '
        + 'deferred/blocked steps without replaying completed destructive actions. Each call '
        + 'increments Goal revision and keeps history. The reply reports continuation_required '
        + 'and next_tool_call for the resulting state.',
      inputSchema: z.object({
        session_id: z.string().min(1).describe('Existing DSH session that already has a Goal'),
        action: z.enum(['revise', 'defer', 'resume']).optional()
          .describe('revise (default), defer a step, or resume deferred/blocked work'),
        goal: z.string().max(20000).optional().describe('Replacement goal text (revise)'),
        plan: z.string().max(20000).optional().describe('Replacement plan'),
        expected_revision: z.number().int().min(1).optional().describe('Optimistic lock on current Goal revision'),
        execution_mode: z.enum(['standard', 'minimal', 'strict']).optional(),
        constraints: constraintSchema.optional(),
        defer_steps: z.array(z.string().min(1)).optional()
          .describe('Step ids, kinds, or content fragments to defer (e.g. npm_publish)'),
        resume_steps: z.array(z.string().min(1)).optional()
          .describe('Step ids/kinds to resume; omit on action=resume to resume all deferred steps'),
        revision_reason: z.string().max(200).optional(),
        request_id: z.string().min(1).max(200).optional(),
        workspace_lock_override: z.boolean().optional().describe('Take over an existing mutable workspace lock.'),
      }),
      annotations: A_DRIVES_AGENT,
    },
    safe(async (args: {
      session_id: string;
      action?: 'revise' | 'defer' | 'resume';
      goal?: string;
      plan?: string;
      expected_revision?: number;
      execution_mode?: 'standard' | 'minimal' | 'strict';
      constraints?: unknown;
      defer_steps?: string[];
      resume_steps?: string[];
      revision_reason?: string;
      request_id?: string;
      workspace_lock_override?: boolean;
    }) => bridge.updateGoal({ ...args, constraints: parseConstraints(args.constraints) })),
  );

  server.registerTool(
    'dsh_wait_goal',
    {
      title: 'Wait on a supervised DSH goal',
      description:
        'Bounded long-poll (default 25s, max 30s) of one DSH session, returning its current ' +
        'status and any newly observed progress. Effects: it is a read of session state, and it ' +
        'advances this bridge\'s own progress cursor, releases the workspace lock for a terminal ' +
        'goal and removes goal-owned temp resources. It never starts, resumes or re-dispatches ' +
        'work. continuation_required and next_tool_call state whether more observable work is in ' +
        'flight. A status of waiting_for_approval or waiting_for_user means DSH is blocked on a ' +
        'human decision, reported with needs_user_action, the pending approval or question, and ' +
        'that decision is only ever made explicitly through dsh_approve or dsh_answer_question; ' +
        'nothing is approved or answered automatically.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        wait_seconds: z.number().int().min(1).max(30).optional().describe('Max seconds to wait (default 25)'),
      }),
      annotations: A_WAITS_ON_AGENT,
    },
    safe(async (args: { session_id: string; wait_seconds?: number }) =>
      bridge.waitGoal(args.session_id, args.wait_seconds)),
  );

  server.registerTool(
    'dsh_stop_goal',
    {
      title: 'Stop a supervised DSH goal',
      description:
        'Use when the user asks to stop, cancel, or interrupt the supervised DSH goal. Idempotent: ' +
        'already completed/cancelled/failed sessions return already_stopped=true without error. ' +
        'Cancels through DSH agent.cancel and fails-closed any pending approval or question. ' +
        'Does not kill processes.',
      inputSchema: z.object({ session_id: z.string().min(1) }),
      annotations: A_LOCAL_DESTRUCTIVE,
    },
    safe(async (args: { session_id: string }) => bridge.stopGoal(args.session_id)),
  );

  // Direct local operations: no agent, no session, no model turn. Registered
  // last so the agent-control surface stays readable at the top of the file.
  if (directOps !== undefined) {
    registerDirectOpsTools(server, directOps);
  }

  // Publish a fingerprint of the REAL tools/list payload this server will serve.
  // The SDK keeps the JSON schemas it advertises, so this hashes what a client
  // actually receives, not the Zod objects or a hand-written summary.
  registerToolSurfaceFingerprint(server);
  return server;
}
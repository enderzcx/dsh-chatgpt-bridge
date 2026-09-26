/**
 * Bridge core: maps MCP operations onto the DSH capability seams. The bridge
 * never re-implements DSH — it drives ctx.agents / ctx.sessions /
 * ctx.sessionPersistence / ctx.sessionTitle / ctx.workspaceRegistry and
 * answers ctx.approval + ctx.userQuestions through their plugin seams.
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentOptions, InboxTarget, ModelSelection } from '@deepseek-ai/dsh-agent';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import {
  SessionId,
  SessionLogOffset,
  type Session,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session';

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'agent-preset/selected': { agentPreset: string };
  }
}
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title';
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval';
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions';
import type { Workspace } from '@deepseek-ai/dsh-workspace';
import type { ResolvedBridgeConfig } from './config.js';
import type { BridgeLogger } from './log.js';
import { redactText } from './redact.js';
import {
  durableSnapshot,
  goalMessageOf,
  hasNonTextBlocks,
  liveSnapshot,
  locatePending,
  messageVersion,
  pendingView,
  positionResult,
  replaceText,
  targetFor,
  type Delivery,
  type PendingMessageView,
} from './inbox.js';
import {
  deriveStatus,
  foldPendingMessages,
  openAskUserQuestions,
  undecidedApprovals,
  type BridgeStatus,
} from './status.js';
import {
  assistantTextForTurn,
  changedFilesForTurn,
  lastEventTime,
  lastTurnSpan,
  summarizeMessages,
  toolCallsForTurn,
  type MessageRow,
  type ToolCallInfo,
} from './session-view.js';
import {
  DEFAULT_WAIT_SECONDS,
  RequestIdMap,
  WAIT_POLL_MS,
  buildSupervisedGoalContext,
  clampWaitSeconds,
  executionView,
  fingerprintStart,
  isActiveStatus,
  isTerminalStatus,
  isWaitingStatus,
  mapStartGoal,
  mapWaitGoal,
  titleFromGoal,
  type ExecutionSupervisionView,
  type GoalStartResult,
  type GoalWaitResult,
} from './goal.js';
import {
  changedFileCountOf,
  commandForCall,
  filePathsForCall,
  foldGoalFacts,
  successfulKinds,
  type ActionKind,
  type LooseEvent,
} from './goal-facts.js';
import { reconcileTodos } from './goal-reconcile.js';
import {
  buildGoalGraph,
  deferredKindsOf,
  describeBlocked,
  detectDeferredKinds,
  inferBlockedKind,
  resolveStepRefs,
  type BlockedInfo,
} from './goal-graph.js';
import { PollCursorMap, computeProgressDelta, nextPollCursor } from './goal-delta.js';
import { cleanupTempResources, discoverTempResources } from './temp-resources.js';
import {
  GoalControlStore,
  appendGoalEvent,
  applyNativeGetGoalResult,
  applyRevision,
  createGoalRecord,
  fileStoreIo,
  goalControlDir,
  sliceHistory,
  supervisionGoal,
  isGoalSemanticallyEqual,
  pruneBlockers,
  type GoalHistoryEvent,
  type GoalRecord,
  type GoalSupervisionView,
} from './goal-control.js';
import {
  evaluateConstraint,
  findPostHocViolation,
  parseConstraints,
  parseExecutionMode,
  classesForTool,
  type ExecutionMode,
  type GoalConstraints,
} from './goal-constraints.js';
import { validateGoalPreflight } from './goal-preflight.js';
import { evaluateApproval, DEFAULT_APPROVAL_POLICY, type UserApprovalPolicy } from './approval-policy.js';
import { WorkspaceConcurrencyGuard, type WorkspaceBaseline } from './workspace-guard.js';
import { ExecutionIdempotencyManager, idempotencyKindFor, isVerifiedKind } from './execution-idempotency.js';
import { buildResultSchema, inspectCredentials, type ResultSchema, type CredentialStatus } from './result-schema.js';
import { isPathInsideWorkspace } from './paths.js';
import { SecretStore } from './control/secret-store.js';
import {
  asApiProxy,
  cancelQuestion,
  compositionHasWebGateway,
  respondApproval,
  respondQuestion,
  startMuxMirror,
  type ApiProxyLike,
} from './web-gateway.js';
import { BRIDGE_NAME, BRIDGE_VERSION } from './version.js';
import { pathsEqual } from './paths.js';

export { normalizePath } from './paths.js';

/** Typed bridge error with a stable machine-readable code. */
export class BridgeError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** One parked approval waiting on a ChatGPT decision. */
export interface PendingApproval {
  id: string;
  sessionId: string;
  toolName: string;
  callId?: string;
  reason?: string;
  command?: string;
  capability?: string;
  level?: string;
  resolve: (outcome: ApprovalOutcome) => void;
  /** Set when the Web api-proxy parked this ask; settle via respond(). */
  muxRpcId?: string;
}

/** Who blocked or decided an approval, for deadlock diagnostics. */
export type ApprovalLayer = 'user' | 'bridge_policy' | 'dsh_policy' | 'platform';

export interface ApprovalRequestLike {
  agent: {
    id: string;
    session?: {
      snapshotEvents?: () => readonly SessionEvent[];
      header?: { cwd?: string };
    };
  };
  toolName: string;
  callId?: string;
  reason?: string;
  signal?: AbortSignal;
}

/** One parked user question waiting on a ChatGPT answer. */
export interface PendingQuestion {
  id: string;
  callId?: string;
  sessionId?: string;
  questions: AskUserQuestionItem[];
  resolve: (answer: AskUserQuestionAnswer) => void;
  muxRpcId?: string;
}

/** Wire-safe approval summary shown in dsh_get_session / dsh_get_task_status. */
export interface ApprovalSummary {
  approval_id: string;
  session_id: string;
  tool_name: string;
  call_id?: string;
  reason?: string;
}

/** Wire-safe question summary shown in dsh_get_session / dsh_get_task_status. */
export interface QuestionSummary {
  question_id: string;
  session_id?: string;
  questions: AskUserQuestionItem[];
}

export interface WaitingState {
  approvals: ApprovalSummary[];
  questions: QuestionSummary[];
}

export interface HealthReport {
  status: string;
  bridge: { name: string; version: string };
  dsh: { version: string };
  runtime: { pid: number; uptimeMs: number };
  sessions: { live: number; persisted: number; active: number };
  capabilities: {
    transports: string[];
    authMode: 'token' | 'none';
    workspaceRegistry: boolean;
    sessionPersistence: boolean;
    agentPresets: boolean;
    userQuestions: boolean;
    approvals: boolean;
    workspaces: number;
    webSurface: boolean;
    goalSupervision: boolean;
  };
}

export interface WorkspaceView {
  id: string;
  title: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  sessionCount: number;
}

export interface SessionView {
  session_id: string;
  title?: string;
  workspace?: string;
  status: BridgeStatus;
  created_at: string;
  updated_at?: string;
  agent?: { status: 'idle' | 'running'; inbox: { nextTurn: number; nextStep: number } };
  pending: { nextTurn: number; nextStep: number };
  waiting: WaitingState;
  messages: MessageRow[];
  last_turn?: { turn: number; reason?: string };
  todos?: { content: string; status: string }[];
  blocked?: BlockedInfo;
  deferred_steps?: string[];
  blocked_steps?: string[];
  remaining_runnable_steps?: string[];
  goal?: GoalSupervisionView;
  execution?: ExecutionSupervisionView;
  history?: GoalHistoryEvent[];
}

export interface SessionSummary {
  session_id: string;
  title?: string;
  workspace?: string;
  status?: BridgeStatus;
  created_at: string;
  updated_at?: string;
}

/**
 * Outcome of one accepted delivery.
 *
 * `state: 'queued'` means only that DSH's inbox holds the message: a later
 * step or turn boundary claims it, and the durable log records that admission.
 * `accepted` therefore never claims the model read or understood the text.
 */
export interface DeliveryResult {
  session_id: string;
  /**
   * Legacy acknowledgement, preserved verbatim for older MCP clients.
   *
   * It carries the same narrow meaning it always had: DSH accepted the message
   * into its pending inbox. It never means the model has read or understood it.
   */
  accepted: true;
  message_id: string;
  /** The pending list the message actually reached. */
  target: 'next-turn' | 'next-step';
  delivery: Delivery;
  /**
   * `queued` means DSH still holds it in a pending list. `admitted` means a turn
   * or step boundary already claimed it into the transcript before this receipt
   * was built — a real outcome, not a failure, and never a reason to re-send.
   */
  state: 'queued' | 'admitted';
  /** Content digest of exactly what was queued; pass it back to refuse stale mutations. */
  version: string;
  queue: { nextTurn: number; nextStep: number };
  note: string;
}

/** Outcome of a queue mutation, with the position it occupied before. */
export interface MessageMutationResult {
  message_id: string;
  target: 'next-turn' | 'next-step';
  delivery: Delivery;
  index: number;
  /** Content digest after the mutation. */
  version: string;
  /** `steer` is DSH's own queue action name for promoting a queued turn. */
  action: 'steer' | 'edit' | 'withdraw';
  previous: { message_id: string; target: 'next-turn' | 'next-step'; delivery: Delivery; index: number; version: string };
  queue: { nextTurn: number; nextStep: number };
}

export interface ResultView {
  session_id: string;
  status: BridgeStatus;
  turn: number;
  summary: string;
  assistant_text: string;
  changed_files: string[];
  tool_calls: ToolCallInfo[];
  error?: { code: string; message: string };
  result_schema?: ResultSchema;
}

/** One loaded session view: the live agent when attached, else persisted events. */
interface LoadedView {
  agent?: Agent;
  session?: Session;
  events: readonly SessionEvent[];
  header: SessionHeader;
}

const require = createRequire(import.meta.url);

/** DSH version string, resolved lazily from the installed package. */
export function dshVersion(): string {
  try {
    return (require('@deepseek-ai/dsh/package.json') as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '…[truncated]';
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Resolve effective session preset from its header and subsequent selection events. */
function resolveSessionPreset(
  header: { agentPreset?: string },
  events?: readonly SessionEvent[],
): string | undefined {
  let preset = header.agentPreset;
  if (events !== undefined) {
    for (const event of events) {
      if (
        event.type === 'agent-preset/selected' &&
        typeof event.data === 'object' &&
        event.data !== null &&
        'agentPreset' in event.data
      ) {
        preset = (event.data as { agentPreset?: string }).agentPreset;
      }
    }
  }
  return preset;
}

/** The bridge service. One instance per plugin activation. */
export class Bridge {
  private readonly ctx: Context;
  private readonly cfg: ResolvedBridgeConfig;
  private readonly log: BridgeLogger;
  /** Sessions created through this bridge (approval answering scope). */
  private readonly managed = new Set<string>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly questions = new Map<string, PendingQuestion>();
  private questionSeq = 0;
  private approvalsEnabled = false;
  private questionsEnabled = false;
  private started = false;
  private readonly goalRequests = new RequestIdMap();
  private readonly goalStore: GoalControlStore;
  private readonly pollCursors = new PollCursorMap();
  private apiProxy: ApiProxyLike | undefined;
  private muxAbort: AbortController | undefined;
  private webOwnsApprovals = false;

  readonly workspaceGuard = new WorkspaceConcurrencyGuard();
  readonly idempotencyManager = new ExecutionIdempotencyManager();
  private readonly workspaceBaselines = new Map<string, WorkspaceBaseline>();
  private readonly recordedMutationCalls = new Set<string>();
  private readonly recordedExecutionEvidenceCalls = new Set<string>();
  private readonly observedSuccessfulMutationCalls = new Set<string>();
  private readonly pendingBaselineRefresh = new Set<string>();
  private readonly pendingExecutionFingerprints = new Map<string, { kind: string; fingerprint: string }>();
  approvalPolicy: UserApprovalPolicy = DEFAULT_APPROVAL_POLICY;

  /** Test hooks for bounded wait loops. */
  now: () => number = () => Date.now();
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  constructor(ctx: Context, cfg: ResolvedBridgeConfig, log: BridgeLogger) {
    this.ctx = ctx;
    this.cfg = cfg;
    this.log = log;
    if (cfg.approvalPolicy) {
      this.approvalPolicy = { ...DEFAULT_APPROVAL_POLICY, ...cfg.approvalPolicy };
    }
    const home = typeof cfg.dshHome === 'string' && cfg.dshHome !== '' ? cfg.dshHome : undefined;
    this.goalStore = new GoalControlStore(
      home === undefined ? undefined : fileStoreIo(goalControlDir(home)),
    );
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /** Register the approval answerer and the user-questions provider. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.apiProxy = asApiProxy(this.ctx.get('apiProxy'));
    // api-proxy starts later than this plugin (more inject deps). If the
    // loader already lists it, do not steal the userQuestions slot.
    const webGatewayPending = this.apiProxy === undefined && compositionHasWebGateway(this.ctx);

    if (this.apiProxy !== undefined || webGatewayPending) {
      // Same process as DSH Web: observe mux, settle through respond(). Do not
      // steal the single userQuestions slot or the approval waterfall.
      this.webOwnsApprovals = true;
      this.approvalsEnabled = true;
      this.questionsEnabled = true;
      const attachMux = (api: ApiProxyLike): void => {
        this.apiProxy = api;
        this.muxAbort?.abort();
        this.muxAbort = new AbortController();
        startMuxMirror(
          api,
          {
            onApprovalRequested: (pending) => {
              this.approvals.set(pending.approvalId, {
                id: pending.approvalId,
                sessionId: pending.sessionId,
                toolName: pending.toolName,
                callId: pending.callId,
                reason: pending.reason,
                muxRpcId: pending.rpcId,
                resolve: () => {},
              });
              this.log.info(`approval ${pending.approvalId} mirrored from Web mux for session ${pending.sessionId}`);
            },
            onApprovalResolved: (_sessionId, approvalId) => {
              this.approvals.delete(approvalId);
            },
            onQuestionRequested: (pending) => {
              this.questions.set(pending.rpcId, {
                id: pending.rpcId,
                sessionId: pending.sessionId,
                questions: pending.questions as AskUserQuestionItem[],
                muxRpcId: pending.rpcId,
                resolve: () => {},
              });
              this.log.info(`question ${pending.rpcId} mirrored from Web mux for session ${pending.sessionId}`);
            },
            onQuestionResolved: (_sessionId, questionRpcId) => {
              this.questions.delete(questionRpcId);
            },
          },
          this.muxAbort.signal,
          (message) => this.log.warn(`apiProxy mux mirror ended: ${redactText(message)}`),
        );
      };
      if (this.apiProxy !== undefined) {
        attachMux(this.apiProxy);
      } else {
        this.ctx.inject(['apiProxy'], () => {
          const api = asApiProxy(this.ctx.get('apiProxy'));
          if (api !== undefined) attachMux(api);
        });
      }
    } else {
      // Headless: this process owns the answerer seams.
      this.webOwnsApprovals = false;
      this.approvalsEnabled = true;
      this.questionsEnabled = true;
    }

    // Same process as DSH Web: the Web surface keeps the interactive composer
    // and the bridge keeps a pending entry, so the human may answer in either
    // surface (first answer wins). Headless keeps the bridge as the only
    // answerer. next() is still called exactly once per request.
    this.ctx.on('user-questions/request', async (request, next) => {
      const sessionId = request.agent?.id;
      if (!this.questionsEnabled || sessionId === undefined || !this.managed.has(sessionId)) {
        return next();
      }
      const callId = openAskUserQuestions(request.agent?.session?.snapshotEvents?.() ?? [])[0]?.callId;
      const id = callId ?? `question-${++this.questionSeq}`;
      // A Web-side failure (for example no browser attached) must not settle the
      // bridge entry: the question stays parked for dsh_answer_question.
      const viaWeb = this.webOwnsApprovals
        ? Promise.resolve()
            .then(() => next())
            .catch((error: unknown) => {
              this.log.warn(
                `web question answerer unavailable for ${id}: ${error instanceof Error ? error.message : String(error)}`,
              );
              return undefined;
            })
        : undefined;
      return new Promise<AskUserQuestionAnswer>((resolve) => {
        this.questions.set(id, {
          id,
          callId,
          sessionId,
          questions: request.questions,
          resolve: (answer) => {
            this.questions.delete(id);
            resolve(answer);
          },
        });
        this.log.info(
          `question ${id} pending for session ${sessionId}${viaWeb === undefined ? '' : ' (web composer + bridge)'}`,
        );
        if (viaWeb !== undefined) {
          void viaWeb.then((answer) => {
            if (answer === undefined) return;
            this.questions.delete(id);
            resolve(answer);
          });
        }
      });
    }, { global: true, prepend: true });

    this.ctx.on('approval/request', (request, next) => this.decideApproval(request as ApprovalRequestLike, next), { global: true, prepend: true });

    this.ctx.effect(() => () => {
      this.muxAbort?.abort();
      for (const pending of [...this.approvals.values()]) {
        this.approvals.delete(pending.id);
        pending.resolve('cancelled');
      }
      for (const pending of [...this.questions.values()]) {
        this.questions.delete(pending.id);
        pending.resolve({ answers: [] });
      }
    });
  }

  private adopt(sessionId: string): void {
    this.managed.add(sessionId);
  }

  /** Count of bridge-created sessions still live. */
  managedCount(): number {
    return this.managed.size;
  }

  // ── model selection + composition (mirrors the web api-proxy) ─────────────

  private agentOptions(): AgentOptions {
    const defaults = this.ctx.get('agentDefaultModel');
    if (defaults !== undefined) {
      const selection = defaults.currentSelection();
      return { provider: selection.provider, model: selection.model };
    }
    return { provider: 'deepseek-official', model: 'deepseek-v4-flash' };
  }

  /** Agent-scoped model selection with log-derived fallback for resumes. */
  private installSelection(agentCtx: Context, agent: Agent): void {
    const defaults = this.ctx.get('agentDefaultModel');
    let picked: ModelSelection | undefined;
    const selection: { current: ModelSelection; assembled: ModelSelection | undefined } = {
      get current() {
        if (picked !== undefined) return picked;
        const logged = agent.session.requestHeader()?.config;
        if (logged !== undefined) {
          return {
            provider: logged.provider,
            model: logged.model,
            ...(logged.reasoningEffort !== undefined ? { reasoningEffort: logged.reasoningEffort } : {}),
          };
        }
        if (defaults !== undefined) return defaults.currentSelection();
        return { provider: 'deepseek-official', model: 'deepseek-v4-flash' };
      },
      set current(next) {
        picked = next;
      },
      assembled: undefined,
    };
    installModelSelection(agentCtx, selection);
  }

  /** Compose the preset+selection setup used at agent creation/resume. */
  private async composeSetupFor(presetId: string | undefined): Promise<{
    agentPreset?: string;
    setup: (agentCtx: Context, agent: Agent) => Promise<void> | void;
  }> {
    const presets = this.ctx.get('agentPresets');
    if (presets === undefined) {
      return {
        setup: (agentCtx, agent) => {
          this.installSelection(agentCtx, agent);
        },
      };
    }
    const resolvedId = presetId ?? (await presets.resolve(undefined)).id;
    return {
      agentPreset: resolvedId,
      setup: async (agentCtx, agent) => {
        this.installSelection(agentCtx, agent);
        await presets.mount(agentCtx, resolvedId);
      },
    };
  }

  // ── session loading ───────────────────────────────────────────────────────

  private async loadView(sessionId: string): Promise<LoadedView> {
    const liveAgent = this.ctx.agents.get(SessionId(sessionId));
    if (liveAgent !== undefined) {
      return { agent: liveAgent, session: liveAgent.session, events: liveAgent.session.snapshotEvents(), header: liveAgent.session.header };
    }
    const persistence = this.ctx.get('sessionPersistence');
    if (persistence === undefined) {
      throw new BridgeError('SESSION_NOT_FOUND', `session ${sessionId} is not live and no session persistence is mounted`);
    }
    try {
      const handle = await persistence.open(SessionId(sessionId), 'read');
      try {
        const { events } = await handle.read();
        return { events, header: handle.header };
      } finally {
        await handle.close();
      }
    } catch {
      throw new BridgeError('SESSION_NOT_FOUND', `session ${sessionId} is not live and has no persisted log`);
    }
  }

  /** Resolve a live agent, resuming the persisted session when needed. */
  private async ensureAgent(sessionId: string): Promise<Agent> {
    const live = this.ctx.agents.get(SessionId(sessionId));
    if (live !== undefined) return live;
    const persistence = this.ctx.get('sessionPersistence');
    if (persistence === undefined) {
      throw new BridgeError('SESSION_NOT_FOUND', `session ${sessionId} is not live and no session persistence is mounted`);
    }
    let header: SessionHeader;
    let events: readonly SessionEvent[];
    try {
      const handle = await persistence.open(SessionId(sessionId), 'read');
      try {
        header = handle.header;
        events = (await handle.read()).events;
      } finally {
        await handle.close();
      }
    } catch {
      throw new BridgeError('SESSION_NOT_FOUND', `session ${sessionId} is not live and has no persisted log`);
    }
    const presetId = resolveSessionPreset(header, events);
    const composition = await this.composeSetupFor(presetId);
    const { agent } = await this.ctx.agents.resume({
      resumeSessionId: SessionId(sessionId),
      agentOptions: this.agentOptions(),
      setup: composition.setup,
    });
    return agent;
  }

  // ── workspace boundary ────────────────────────────────────────────────────

  async listWorkspaces(): Promise<WorkspaceView[]> {
    const registry = this.ctx.get('workspaceRegistry');
    if (registry === undefined) {
      throw new BridgeError('WORKSPACE_REGISTRY_UNAVAILABLE', 'no workspace registry is mounted in this profile');
    }
    return registry.list().map((workspace) => ({
      id: workspace.id,
      title: workspace.title,
      path: workspace.path,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
      sessionCount: workspace.sessionIds.length,
    }));
  }

  /**
   * Resolve a workspace reference (id, canonical path, or title) against the
   * REGISTERED workspace set only. Never auto-registers and never opens an
   * arbitrary path: an unregistered path is rejected.
   */
  async resolveWorkspace(input: string): Promise<Workspace> {
    const registry = this.ctx.get('workspaceRegistry');
    if (registry === undefined) {
      throw new BridgeError('WORKSPACE_REGISTRY_UNAVAILABLE', 'no workspace registry is mounted in this profile');
    }
    const all = registry.list();
    const byId = all.find((workspace) => workspace.id === input);
    if (byId !== undefined) return byId;
    const byPath = all.find((workspace) => pathsEqual(workspace.path, input));
    if (byPath !== undefined) return byPath;
    const byTitle = all.find((workspace) => workspace.title === input);
    if (byTitle !== undefined) return byTitle;
    throw new BridgeError(
      'WORKSPACE_NOT_FOUND',
      `no registered workspace matches "${input}"; sessions can only be created in workspaces DSH already registered (dsh_list_workspaces)`,
    );
  }

  // ── operations ────────────────────────────────────────────────────────────

  async health(): Promise<HealthReport> {
    const agents = this.ctx.agents.list();
    let persisted = 0;
    try {
      persisted = (await this.ctx.get('sessionPersistence')?.list())?.length ?? 0;
    } catch {
      persisted = -1;
    }
    const workspaces = this.ctx.get('workspaceRegistry')?.list() ?? [];
    return {
      status: 'ok',
      bridge: { name: BRIDGE_NAME, version: BRIDGE_VERSION },
      dsh: { version: dshVersion() },
      runtime: { pid: process.pid, uptimeMs: Math.round(process.uptime() * 1000) },
      sessions: {
        live: agents.length,
        persisted: Math.max(persisted, 0),
        active: agents.filter((agent) => agent.status === 'running').length,
      },
      capabilities: {
        transports: this.cfg.transport === 'stdio' ? ['stdio'] : ['streamable-http'],
        authMode: this.cfg.authMode,
        workspaceRegistry: this.ctx.get('workspaceRegistry') !== undefined,
        sessionPersistence: this.ctx.get('sessionPersistence') !== undefined,
        agentPresets: this.ctx.get('agentPresets') !== undefined,
        userQuestions: this.questionsEnabled,
        approvals: this.approvalsEnabled,
        workspaces: workspaces.length,
        webSurface: this.apiProxy !== undefined || this.ctx.get('webRuntime') !== undefined,
        goalSupervision: true,
      },
    };
  }

  async createSession(
    workspaceInput: string,
    title?: string,
    initialMessage?: string,
  ): Promise<SessionView> {
    const workspace = await this.resolveWorkspace(workspaceInput);
    const sessionId = `session-${randomUUID()}`;
    const composition = await this.composeSetupFor(undefined);
    let agent: Agent;
    try {
      const handle = await this.ctx.agents.create({
        sessionId: SessionId(sessionId),
        agentOptions: this.agentOptions(),
        meta: {
          cwd: workspace.path,
          ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
        },
        setup: composition.setup,
      });
      agent = handle.agent;
    } catch (error) {
      throw new BridgeError(
        'SESSION_CREATE_FAILED',
        `failed to create DSH session in workspace "${workspace.title}": ${redactText(error instanceof Error ? error.message : String(error))}`,
      );
    }
    this.adopt(sessionId);
    try {
      await workspace.attachSession(SessionId(sessionId));
    } catch (error) {
      this.log.warn(`session ${sessionId} could not attach to workspace ${workspace.id}: ${redactText(String(error))}`);
    }
    if (title !== undefined && title !== '') {
      try {
        this.ctx.sessionTitle?.rename(agent.session, title);
      } catch (error) {
        this.log.warn(`session ${sessionId} title rejected: ${redactText(String(error))}`);
      }
    }
    if (initialMessage !== undefined && initialMessage.trim() !== '') {
      // A session's opening prompt owns its own first turn: pin the delivery
      // target instead of inheriting whatever the queue defaults become.
      agent.send(
        createUserMessage({
          content: [{ type: 'text', text: initialMessage }],
          source: { kind: 'user' },
        }),
        'next-turn',
        true,
      );
    }
    return this.viewOf(agent);
  }

  async sendMessage(sessionId: string, message: string): Promise<{ session_id: string; accepted: boolean }> {
    const delivered = await this.deliverMessage(sessionId, message, 'followup');
    return { session_id: delivered.session_id, accepted: delivered.accepted };
  }

  // ── pending input / steering ──────────────────────────────────────────────
  //
  // Delivery and queue management are expressed entirely through DSH's own
  // Agent inbox. Delivery uses `send`; repositioning reuses the same
  // `remove(id)` + `steer(message)` sequence the DSH session controller's own
  // queue command uses; edit and withdraw use the inbox's `replace`/`remove`.
  // The bridge keeps no queue of its own, so one message cannot be delivered
  // twice and no hand-rolled splice ever stands in for a real steer.

  /**
   * Deliver one message to the live agent's inbox.
   * @param sessionId - the session that owns the agent.
   * @param message - the text to deliver; must not be blank.
   * @param delivery - `followup` queues its own turn (DSH's default), `steer`
   *   is consumed at the nearest step boundary.
   * @returns the accepted identity and the destination it actually reached.
   */
  async deliverMessage(sessionId: string, message: string, delivery: Delivery = 'followup'): Promise<DeliveryResult> {
    if (message.trim() === '') throw new BridgeError('EMPTY_MESSAGE', 'message must not be empty');
    if (delivery !== 'followup' && delivery !== 'steer') {
      throw new BridgeError('DELIVERY_UNSUPPORTED', `delivery must be "followup" or "steer", received ${JSON.stringify(delivery)}`);
    }
    this.adopt(sessionId);
    const agent = await this.ensureAgent(sessionId);
    const inbox = this.requireInbox(sessionId, agent);
    const created = createUserMessage({
      content: [{ type: 'text', text: message }],
      source: { kind: 'user' },
    });
    const messageId = String(created.id);
    // Snapshot the log length before delivering, so "was this admitted?" asks
    // about this delivery rather than about an unrelated earlier message.
    const eventsBefore = this.eventsOf(agent).length;
    // DSH's one delivery primitive; `followup` and `steer` are thin wrappers.
    agent.send(created, targetFor(delivery), true);

    // Read back by identity. A step boundary can claim the message before this
    // line runs — a steer is consumed at the very next step — so "not in the
    // inbox" does not by itself mean the delivery failed. Check the transcript
    // for the same message id before reporting anything.
    const landed = locatePending(liveSnapshot(agent), messageId);
    if (landed === undefined && !this.wasAdmittedSince(agent, messageId, eventsBefore)) {
      throw new BridgeError(
        'DELIVERY_NOT_ACCEPTED',
        `DSH holds no pending copy of message ${messageId} and the transcript has no record of it; the queue may have been cleared concurrently. Re-read the queue before retrying.`,
        {
          session_id: sessionId,
          message_id: messageId,
          requested_delivery: delivery,
          queue: this.queueState(agent),
        },
      );
    }
    if (landed === undefined) {
      // Consumed faster than this receipt: report that truthfully instead of
      // claiming it is still queued. Nothing is re-delivered.
      return {
        session_id: sessionId,
        accepted: true,
        message_id: messageId,
        target: targetFor(delivery),
        delivery,
        state: 'admitted',
        version: messageVersion(created),
        queue: this.queueState(agent),
        note: 'accepted and already claimed into the transcript before this receipt was built; it is not queued now. This does not mean the model has read it.',
      };
    }
    const target = landed.target;
    if (target !== targetFor(delivery)) {
      // DSH parks waking input for the next turn when it arrives after an
      // active cancellation. Report where it really landed, not the request.
      this.log.warn(`message ${messageId} was parked in ${target} instead of ${targetFor(delivery)} (active cancellation)`);
    }
    return {
      session_id: sessionId,
      accepted: true,
      message_id: messageId,
      target,
      delivery: target === 'next-step' ? 'steer' : 'followup',
      state: 'queued',
      version: messageVersion(created),
      queue: this.queueState(agent),
      note:
        target === 'next-step'
          ? 'queued for the next step boundary; not yet part of the transcript'
          : 'queued as its own next turn; not yet part of the transcript',
    };
  }

  /** Whether the transcript gained this identity after {@link fromIndex}. */
  private wasAdmittedSince(agent: Agent, messageId: string, fromIndex: number): boolean {
    const wanted = String(messageId);
    const events = this.eventsOf(agent);
    // Scan the whole log, not only the tail: a claim can land slightly earlier
    // than the snapshot, and a false "not admitted" would be worse than a scan.
    return events.some((event) => event.type === 'user/message' && String((event.data as { id?: unknown }).id) === wanted);
  }

  /**
   * List the pending inbox with stable identities, in the order DSH claims it.
   *
   * Read-only: a live agent is read from its own inbox, and a cold session is
   * read from the durable log's inbox splices. An idle session is never woken
   * and no agent is created or resumed just to answer this.
   * @param sessionId - the session to read.
   * @param maxChars - per-message text bound.
   * @returns both pending lists, their sizes, and whether the agent is live.
   */
  async listPendingMessages(
    sessionId: string,
    maxChars?: number,
  ): Promise<{
    session_id: string;
    live: boolean;
    agent_status?: 'idle' | 'running';
    next_step: PendingMessageView[];
    next_turn: PendingMessageView[];
    total: number;
  }> {
    if (sessionId.trim() === '') throw new BridgeError('SESSION_REQUIRED', 'session_id is required');
    const view = await this.loadView(sessionId);
    const snapshot = view.agent === undefined ? durableSnapshot(view.events) : liveSnapshot(view.agent);
    const limit = maxChars ?? this.cfg.sessionMaxChars;
    const revision = this.goalStore.get(sessionId)?.revision;
    const nextStep = snapshot.nextStep.map((message, index) => pendingView(message, 'next-step', index, limit, revision));
    const nextTurn = snapshot.nextTurn.map((message, index) => pendingView(message, 'next-turn', index, limit, revision));
    return {
      session_id: sessionId,
      live: view.agent !== undefined,
      ...(snapshot.status === undefined ? {} : { agent_status: snapshot.status }),
      next_step: nextStep,
      next_turn: nextTurn,
      total: nextStep.length + nextTurn.length,
    };
  }

  /**
   * Move one queued `next-turn` message in front of the agent as steering.
   *
   * Mirrors the DSH session controller's own queue `steer` action exactly: the
   * item must still be in `next-turn` and the agent must be `running`, and the
   * move is `remove(id)` followed by `agent.steer(originalMessage)` — so the
   * message is never copied, DSH's own wake/cancellation handling applies, and
   * steering keeps its append order instead of being reversed by hand.
   * @param sessionId - the session that owns the agent.
   * @param messageId - identity of the pending message.
   * @param expectedVersion - optional digest from a prior read; a mismatch refuses the move.
   * @returns the message's new steering position.
   */
  async promotePendingMessage(
    sessionId: string,
    messageId: string,
    expectedVersion?: string,
  ): Promise<MessageMutationResult> {
    return this.mutatePending(sessionId, messageId, 'steer', { expectedVersion });
  }

  /**
   * Replace the text of one pending message, preserving its identity.
   * @param sessionId - the session that owns the agent.
   * @param messageId - identity of the pending message.
   * @param message - the replacement text.
   * @param expectedVersion - optional digest from a prior read; a mismatch refuses the edit.
   * @returns the message's position after the edit.
   */
  async editPendingMessage(
    sessionId: string,
    messageId: string,
    message: string,
    expectedVersion?: string,
  ): Promise<MessageMutationResult> {
    if (message.trim() === '') throw new BridgeError('EMPTY_MESSAGE', 'message must not be empty');
    return this.mutatePending(sessionId, messageId, 'edit', { text: message, expectedVersion });
  }

  /**
   * Remove one pending message from the queue.
   * @param sessionId - the session that owns the agent.
   * @param messageId - identity of the pending message.
   * @param expectedVersion - optional digest from a prior read; a mismatch refuses the withdrawal.
   * @returns the position the message occupied before removal.
   */
  async withdrawPendingMessage(
    sessionId: string,
    messageId: string,
    expectedVersion?: string,
  ): Promise<MessageMutationResult> {
    return this.mutatePending(sessionId, messageId, 'withdraw', { expectedVersion });
  }

  /** Whether the agent exposes the native steering capability and a live inbox. */
  private static nativeSteerCapable(agent: Agent): boolean {
    return agent.inbox !== undefined
      && typeof agent.steer === 'function'
      && typeof agent.send === 'function';
  }

  /**
   * Put an undelivered message back at its recorded position.
   *
   * Only ever called after DSH was confirmed not to hold and not to have
   * admitted the identity, so this cannot create a second copy. The identity is
   * unique across both native lists, which the inbox enforces.
   * @returns whether the restore was applied and verified.
   */
  private restorePending(
    inbox: Agent['inbox'],
    found: { message: UserMessage; target: InboxTarget; index: number },
  ): 'restored' | 'recovery_required' {
    const list = found.target === 'next-turn' ? inbox.nextTurn : inbox.nextStep;
    // An interior position cannot be restored exactly once the list has moved,
    // and DSH has no positional insert that could prove it. Only a position
    // still at the tail can be re-appended and remain provably in order.
    if (found.index !== list.length) return 'recovery_required';
    try {
      const id = String(found.message.id);
      inbox.splice(found.target, list.length, 0, [found.message]);
      const inTurn = inbox.nextTurn.filter((message) => String(message.id) === id).length;
      const inStep = inbox.nextStep.filter((message) => String(message.id) === id).length;
      const placed = found.target === 'next-turn' ? inbox.nextTurn : inbox.nextStep;
      // Exactly one copy, the identical object, at the position it just left.
      return inTurn + inStep === 1 && placed[found.index] === found.message
        ? 'restored'
        : 'recovery_required';
    } catch {
      return 'recovery_required';
    }
  }

  /** The visible text of one pending message, for diagnostics only. */
  private static inboxText(message: UserMessage): string {
    return message.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { text: string }).text)
      .join('\n');
  }

  /** Read the live agent's inbox, or explain why this session cannot be queued into. */
  private requireInbox(sessionId: string, agent: Agent): Agent['inbox'] {
    const inbox = agent.inbox;
    if (inbox === undefined) {
      throw new BridgeError(
        'INBOX_UNAVAILABLE',
        `session ${sessionId} has no agent inbox; its DSH profile does not mount the agent loop`,
      );
    }
    return inbox;
  }

  /** Report the current native pending sizes. */
  private queueState(agent: Agent): { nextTurn: number; nextStep: number } {
    return { nextTurn: agent.inbox.nextTurn.length, nextStep: agent.inbox.nextStep.length };
  }

  /**
   * Apply one queue mutation through the native inbox operations.
   *
   * Every guard runs against a single synchronous snapshot, so no step boundary
   * can claim the message between the decision and the mutation. A message is
   * only ever removed as the first half of an operation whose second half is
   * the native re-delivery, which cannot silently fail: if the native call
   * throws, the caller sees the error rather than a silently dropped message.
   * @param sessionId - the session that owns the agent.
   * @param messageId - identity of the pending message.
   * @param action - the mutation to apply.
   * @param options - replacement text for `edit`, and the caller's expected version.
   * @returns the resulting position; for `withdraw`, the position before removal.
   */
  private async mutatePending(
    sessionId: string,
    messageId: string,
    action: 'steer' | 'edit' | 'withdraw',
    options: { text?: string; expectedVersion?: string } = {},
  ): Promise<MessageMutationResult> {
    if (sessionId.trim() === '') throw new BridgeError('SESSION_REQUIRED', 'session_id is required');
    if (messageId.trim() === '') throw new BridgeError('MESSAGE_ID_REQUIRED', 'message_id is required');
    this.adopt(sessionId);
    const agent = await this.ensureAgent(sessionId);
    const inbox = this.requireInbox(sessionId, agent);
    const snapshot = liveSnapshot(agent);
    const found = locatePending(snapshot, messageId);
    if (found === undefined) throw this.staleMessageError(agent, sessionId, messageId, action);
    this.refuseProtectedGoalMessage(sessionId, found.message, action);
    const from = positionResult(found.message, found.target, found.index);
    if (options.expectedVersion !== undefined && options.expectedVersion !== '' && options.expectedVersion !== from.version) {
      throw new BridgeError(
        'MESSAGE_VERSION_CONFLICT',
        `message ${messageId} changed since it was read (expected ${options.expectedVersion}, found ${from.version}); the mutation was refused and nothing was overwritten. Re-read the pending list.`,
        {
          session_id: sessionId,
          message_id: messageId,
          action,
          expected_version: options.expectedVersion,
          actual_version: from.version,
          queue: this.queueState(agent),
        },
      );
    }
    if (action === 'edit') {
      if (hasNonTextBlocks(found.message)) {
        throw new BridgeError(
          'MESSAGE_EDIT_NON_TEXT',
          `message ${messageId} carries content the bridge cannot re-send faithfully (attachments or non-text blocks); editing it by text would drop that data, so the edit was refused. Withdraw it and send a new message instead.`,
          { session_id: sessionId, message_id: messageId, queue: this.queueState(agent) },
        );
      }
      // A refusal here means the identity stopped being pending between the
      // synchronous read above and this call, so classify it from the log
      // rather than asserting a cause. Nothing is ever re-sent to recover.
      if (!inbox.replace(found.message.id, replaceText(found.message, options.text ?? ''))) {
        throw this.staleMessageError(agent, sessionId, messageId, action);
      }
      const after = locatePending(liveSnapshot(agent), messageId);
      if (after === undefined) throw this.staleMessageError(agent, sessionId, messageId, action);
      return {
        ...positionResult(after.message, after.target, after.index),
        action,
        previous: from,
        queue: this.queueState(agent),
      };
    }
    if (action === 'withdraw') {
      if (!inbox.remove(found.message.id)) {
        throw this.staleMessageError(agent, sessionId, messageId, action);
      }
      return { ...from, action, previous: from, queue: this.queueState(agent) };
    }
    // steer: the DSH session controller's own queue rule, applied unchanged.
    if (found.target !== 'next-turn') {
      throw new BridgeError(
        'MESSAGE_NOT_PROMOTABLE',
        `message ${messageId} is already in next-step; only a message queued for a later turn can be promoted to steering.`,
        { session_id: sessionId, message_id: messageId, action, target: found.target, queue: this.queueState(agent) },
      );
    }
    if (agent.status !== 'running') {
      throw new BridgeError(
        'STEER_UNAVAILABLE',
        `session ${sessionId} is not running (agent status ${JSON.stringify(agent.status)}), so its current turn cannot accept steering. Use dsh_start_goal/dsh_wait_goal to drive the session, or wait until it is running.`,
        { session_id: sessionId, message_id: messageId, action, agent_status: agent.status, queue: this.queueState(agent) },
      );
    }
    // Verify the native steering capability before anything leaves the queue, so
    // a missing method is a clean refusal that never touches the inbox.
    if (!Bridge.nativeSteerCapable(agent)) {
      throw new BridgeError(
        'STEER_UNAVAILABLE',
        `session ${sessionId} cannot steer: its agent exposes no native steer()/send() on a live inbox, so the message was left exactly where it was.`,
        { session_id: sessionId, message_id: messageId, action, reason: 'NATIVE_STEER_MISSING', queue: this.queueState(agent) },
      );
    }
    const steerIndex = inbox.nextStep.length;
    if (!inbox.remove(found.message.id)) {
      throw this.staleMessageError(agent, sessionId, messageId, action);
    }
    // Re-deliver the identical object so DSH owns the wake and cancellation
    // handling.
    try {
      agent.steer(found.message);
    } catch (error) {
      // The removal is the only irreversible step, so a failure here is checked
      // against DSH's own state before anything is claimed: a throw does not
      // prove the message went nowhere (DSH can accept a delivery and reject a
      // later phase), and re-sending a delivered message would duplicate it.
      const detail = redactText(error instanceof Error ? error.message : String(error));
      const pendingNow = locatePending(liveSnapshot(agent), messageId);
      if (pendingNow !== undefined) {
        // DSH kept the message: it is queued, just not where the caller asked.
        this.log.warn(`steer() rejected ${messageId} but DSH retained it in ${pendingNow.target}`);
        throw new BridgeError(
          'STEER_REDELIVERY_FAILED',
          `steering ${messageId} was rejected (${detail}), but DSH still holds it in ${pendingNow.target}; it is queued exactly once and was not lost.`,
          {
            session_id: sessionId,
            message_id: messageId,
            action,
            reason: detail,
            delivery_status: 'queued',
            queue: this.queueState(agent),
          },
        );
      }
      if (this.wasAdmitted(agent, messageId)) {
        this.log.warn(`steer() rejected ${messageId} but DSH already admitted it to the transcript`);
        throw new BridgeError(
          'STEER_REDELIVERY_FAILED',
          `steering ${messageId} was rejected after it was already claimed (${detail}); it is in the transcript exactly once.`,
          {
            session_id: sessionId,
            message_id: messageId,
            action,
            reason: detail,
            delivery_status: 'admitted',
            queue: this.queueState(agent),
          },
        );
      }
      // Undelivered: put the identical object back at its recorded position.
      const recovery = this.restorePending(inbox, found);
      this.log.error(`steering ${messageId} failed after it left next-turn: ${detail} (recovery: ${recovery})`);
      if (recovery === 'restored') {
        throw new BridgeError(
          'STEER_REDELIVERY_FAILED',
          `steering ${messageId} was rejected (${detail}). The message was not delivered, so it has been restored to its previous queue position and remains queued exactly once.`,
          {
            session_id: sessionId,
            message_id: messageId,
            action,
            reason: detail,
            delivery_status: 'not_delivered',
            recovery: 'restored',
            queue: this.queueState(agent),
          },
        );
      }
      // Recovery could not be proven, so say so instead of implying no loss.
      throw new BridgeError(
        'STEER_RECOVERY_REQUIRED',
        `steering ${messageId} was rejected (${detail}) and the message could not be put back; it is NOT queued now. Re-send it with dsh_send_message.`,
        {
          session_id: sessionId,
          message_id: messageId,
          action,
          reason: detail,
          delivery_status: 'not_delivered',
          recovery: 'recovery_required',
          text: redactText(Bridge.inboxText(found.message)),
          source_kind: found.message.source.kind,
          queue: this.queueState(agent),
        },
      );
    }
    const after = locatePending(liveSnapshot(agent), messageId);
    return {
      ...(after === undefined
        ? { ...from, target: 'next-step' as const, delivery: 'steer' as const, index: steerIndex }
        : positionResult(after.message, after.target, after.index)),
      action,
      previous: from,
      queue: this.queueState(agent),
    };
  }

  /**
   * Refuse a mutation that would contradict the supervised-Goal record.
   *
   * Goal control envelopes are the durable statement of the Goal, and the
   * bridge reconciles them against the transcript. Editing, withdrawing or
   * re-steering one behind the record's back — or pushing a superseded revision
   * back into the current turn — is exactly the contradiction the Goal
   * supervision path exists to prevent.
   */
  private refuseProtectedGoalMessage(
    sessionId: string,
    message: UserMessage,
    action: 'steer' | 'edit' | 'withdraw',
  ): void {
    if (message.source.kind !== 'user') return;
    const record = this.goalStore.get(sessionId);
    const goal = goalMessageOf(message, record?.revision);
    if (goal === undefined) return;
    const target = 'dsh_update_goal';
    if (goal.stale) {
      throw new BridgeError(
        'GOAL_MESSAGE_STALE',
        `message ${String(message.id)} is a superseded Goal control message (rev ${goal.revision} of ${record?.revision}); it must not be edited, withdrawn or sent back into the current turn. Use ${target} to move the Goal, or withdraw it only if you intend to drop it.`,
        { session_id: sessionId, message_id: String(message.id), action, goal_id: goal.goal_id, message_revision: goal.revision, current_revision: record?.revision },
      );
    }
    throw new BridgeError(
      'GOAL_MESSAGE_PROTECTED',
      `message ${String(message.id)} is a supervised-Goal control message; ${action} would bypass the Goal revision rules. Use ${target} to revise, defer or resume the Goal instead.`,
      { session_id: sessionId, message_id: String(message.id), action, goal_id: goal.goal_id, revision: goal.revision },
    );
  }

  /**
   * Explain an identity that is no longer pending, using the durable log.
   *
   * The three refusals are deliberately distinct, because the caller's right
   * next move differs: an admitted message is already in the transcript, a
   * formerly-pending one was withdrawn or discarded, and an unrecognized one
   * belongs to a different session or never existed.
   */
  private staleMessageError(agent: Agent, sessionId: string, messageId: string, action: string): BridgeError {
    const details = { session_id: sessionId, message_id: messageId, action, queue: this.queueState(agent) };
    if (this.wasAdmitted(agent, messageId)) {
      return new BridgeError(
        'MESSAGE_ALREADY_ADMITTED',
        `message ${messageId} already entered a step and is part of the transcript; it can no longer be promoted, edited or withdrawn.`,
        details,
      );
    }
    if (this.eventsOf(agent).some((event) => event.type === 'agent/inbox/spliced' || event.type === 'user/message')) {
      return new BridgeError(
        'MESSAGE_NOT_PENDING',
        `message ${messageId} is not pending in this inbox: it was already claimed, withdrawn, or discarded by a cancellation. Re-read the pending list before retrying.`,
        details,
      );
    }
    return new BridgeError('MESSAGE_ID_UNKNOWN', `message ${messageId} is not a known message of session ${sessionId}`, details);
  }

  /** Whether DSH already appended this identity to the durable transcript. */
  private wasAdmitted(agent: Agent, messageId: string): boolean {
    const wanted = String(messageId);
    return this.eventsOf(agent).some(
      (event) => event.type === 'user/message' && String((event.data as { id?: unknown }).id) === wanted,
    );
  }

  /** Read a live agent's own durable event log. */
  private eventsOf(agent: Agent): readonly SessionEvent[] {
    try {
      return agent.session.snapshotEvents();
    } catch {
      return [];
    }
  }

  async cancelTask(sessionId: string): Promise<{ session_id: string; cancelled: boolean }> {
    const agent = this.ctx.agents.get(SessionId(sessionId));
    if (agent === undefined) {
      throw new BridgeError('SESSION_NOT_LIVE', `session ${sessionId} is not loaded; only live sessions can be cancelled`);
    }
    agent.cancel({ kind: 'user' });
    return { session_id: sessionId, cancelled: true };
  }

  private waitingFor(sessionId: string, events?: readonly SessionEvent[]): WaitingState {
    const seenApprovals = new Set<string>();
    const approvals: ApprovalSummary[] = [];
    for (const pending of this.approvals.values()) {
      if (pending.sessionId !== sessionId) continue;
      seenApprovals.add(pending.id);
      approvals.push({
        approval_id: pending.id,
        session_id: pending.sessionId,
        tool_name: pending.toolName,
        ...(pending.callId === undefined ? {} : { call_id: pending.callId }),
        ...(pending.reason === undefined ? {} : { reason: pending.reason }),
      });
    }
    if (events !== undefined) {
      for (const item of undecidedApprovals(events)) {
        if (seenApprovals.has(item.id)) continue;
        approvals.push({
          approval_id: item.id,
          session_id: sessionId,
          tool_name: item.toolName,
          ...(item.callId === undefined ? {} : { call_id: item.callId }),
          ...(item.reason === undefined ? {} : { reason: item.reason }),
        });
      }
    }
    const seenQuestions = new Set<string>();
    const questions: QuestionSummary[] = [];
    for (const pending of this.questions.values()) {
      if (pending.sessionId !== sessionId) continue;
      const key = pending.callId ?? pending.id;
      seenQuestions.add(key);
      seenQuestions.add(pending.id);
      questions.push({
        question_id: key,
        ...(pending.sessionId === undefined ? {} : { session_id: pending.sessionId }),
        questions: pending.questions,
      });
    }
    if (events !== undefined) {
      for (const item of openAskUserQuestions(events)) {
        if (seenQuestions.has(item.callId)) continue;
        let parsed: { questions?: AskUserQuestionItem[] } | undefined;
        try {
          parsed = JSON.parse(item.arguments) as { questions?: AskUserQuestionItem[] };
        } catch {
          parsed = undefined;
        }
        questions.push({
          question_id: item.callId,
          session_id: sessionId,
          questions: parsed?.questions ?? [],
        });
      }
    }
    return { approvals, questions };
  }

  private async statusOf(sessionId: string, view: LoadedView): Promise<BridgeStatus> {
    const pending = view.agent !== undefined
      ? { nextTurn: view.agent.inbox.nextTurn.length, nextStep: view.agent.inbox.nextStep.length }
      : foldPendingMessages(view.events);
    const waiting = this.waitingFor(sessionId, view.events);
    return deriveStatus({
      live: view.agent !== undefined,
      agentStatus: view.agent?.status,
      hasPendingInbox: pending.nextTurn + pending.nextStep > 0,
      pendingApprovals: waiting.approvals.length,
      pendingQuestions: waiting.questions.length,
      events: view.events,
    });
  }

  private async titleOf(view: LoadedView): Promise<string | undefined> {
    if (view.session !== undefined) {
      try {
        return this.ctx.sessionTitle?.get(view.session)?.title;
      } catch {
        return undefined;
      }
    }
    try {
      return foldSessionTitle(view.events)?.title;
    } catch {
      return undefined;
    }
  }

  private async viewOf(agent: Agent): Promise<SessionView> {
    return this.getSession(agent.id, this.cfg.sessionMaxItems, this.cfg.sessionMaxChars);
  }

  async getSession(sessionId: string, maxItems?: number, maxChars?: number): Promise<SessionView> {
    const view = await this.loadView(sessionId);
    const items = maxItems ?? this.cfg.sessionMaxItems;
    const chars = maxChars ?? this.cfg.sessionMaxChars;
    const pending = view.agent !== undefined
      ? { nextTurn: view.agent.inbox.nextTurn.length, nextStep: view.agent.inbox.nextStep.length }
      : foldPendingMessages(view.events);
    const waiting = this.waitingFor(sessionId, view.events);
    const status = await this.statusOf(sessionId, view);
    const title = await this.titleOf(view);
    const span = lastTurnSpan(view.events);
    return {
      session_id: sessionId,
      ...(title === undefined ? {} : { title }),
      ...(view.header.cwd === undefined ? {} : { workspace: view.header.cwd }),
      status,
      created_at: iso(view.header.createdAt),
      updated_at: view.agent !== undefined ? lastEventTime(view.events) : undefined,
      ...(view.agent === undefined
        ? {}
        : { agent: { status: view.agent.status, inbox: { nextTurn: pending.nextTurn, nextStep: pending.nextStep } } }),
      pending,
      waiting,
      messages: summarizeMessages(view.events, items, chars),
      ...(span === undefined ? {} : { last_turn: { turn: span.turn, ...(span.reason === undefined ? {} : { reason: span.reason.kind }) } }),
      ...this.goalFields(sessionId, view, status, { readOnly: true }),
    };
  }

  async listSessions(options: { limit?: number; offset?: number; workspace?: string }): Promise<SessionSummary[]> {
    const persistence = this.ctx.get('sessionPersistence');
    const persisted = persistence === undefined ? [] : await persistence.list();
    const live = this.ctx.sessions.list();
    const byId = new Map<string, SessionHeader>();
    for (const snapshot of persisted) byId.set(snapshot.header.id, snapshot.header);
    for (const session of live) byId.set(session.id, session.header);
    let rows = [...byId.values()];
    if (options.workspace !== undefined && options.workspace !== '') {
      const workspace = await this.resolveWorkspace(options.workspace);
      rows = rows.filter((header) => header.cwd !== undefined && pathsEqual(header.cwd, workspace.path));
    }
    rows.sort((a, b) => b.createdAt - a.createdAt);
    const offset = Math.max(options.offset ?? 0, 0);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const page = rows.slice(offset, offset + limit);
    const out: SessionSummary[] = [];
    for (const header of page) {
      const agent = this.ctx.agents.get(header.id);
      let title: string | undefined;
      if (agent !== undefined) {
        title = this.ctx.sessionTitle?.get(agent.session)?.title;
      } else {
        title = await this.cachedTitle(header);
      }
      const status = agent === undefined
        ? undefined
        : deriveStatus({
            live: true,
            agentStatus: agent.status,
            hasPendingInbox: agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0,
            pendingApprovals: this.waitingFor(header.id, agent.session.snapshotEvents()).approvals.length,
            pendingQuestions: this.waitingFor(header.id, agent.session.snapshotEvents()).questions.length,
            events: agent.session.snapshotEvents(),
          });
      out.push({
        session_id: header.id,
        ...(title === undefined ? {} : { title }),
        ...(header.cwd === undefined ? {} : { workspace: header.cwd }),
        ...(status === undefined ? {} : { status }),
        created_at: iso(header.createdAt),
        ...(agent === undefined ? {} : { updated_at: lastEventTime(agent.session.snapshotEvents()) }),
      });
    }
    return out;
  }

  /** Zero-I/O cached title for a cold session, when a projection cache is mounted. */
  private async cachedTitle(header: SessionHeader): Promise<string | undefined> {
    const cache = this.ctx.get('sessionProjectionCache');
    if (cache === undefined) return undefined;
    try {
      const snapshot = cache.cachedSnapshot(header, SessionLogOffset(0));
      const value = snapshot?.values?.title;
      if (typeof value === 'string' && value !== '') return value;
      if (value !== null && typeof value === 'object' && 'title' in (value as Record<string, unknown>)) {
        return (value as { title?: string }).title;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  async getResult(sessionId: string, maxChars?: number): Promise<ResultView> {
    const view = await this.loadView(sessionId);
    const span = lastTurnSpan(view.events);
    if (span === undefined) {
      throw new BridgeError('NO_RESULT_YET', `session ${sessionId} has no turn yet; send a message first`);
    }
    const chars = maxChars ?? this.cfg.resultMaxChars;
    const items = this.cfg.resultMaxItems;
    const text = assistantTextForTurn(view.events, span.turn);
    const status = await this.statusOf(sessionId, view);
    const error = span.reason !== undefined && span.reason.kind === 'error'
      ? { code: span.reason.error.code, message: span.reason.error.message }
      : undefined;
    const resultSchema = await this.getStructuredResult(sessionId).catch(() => undefined);
    return {
      session_id: sessionId,
      status,
      turn: span.turn,
      summary: truncate(text, chars),
      assistant_text: truncate(text, chars),
      changed_files: changedFilesForTurn(view.events, span.turn),
      tool_calls: toolCallsForTurn(view.events, span.turn, items).map((call) => ({
        ...call,
        arguments: truncate(call.arguments, 500),
      })),
      ...(error === undefined ? {} : { error }),
      ...(resultSchema === undefined ? {} : { result_schema: resultSchema }),
    };
  }

  async getTaskStatus(sessionId: string): Promise<{
    session_id: string;
    status: BridgeStatus;
    live: boolean;
    agent_status?: 'idle' | 'running';
    pending: { nextTurn: number; nextStep: number };
    waiting: WaitingState;
    last_turn?: { turn: number; reason?: string };
    updated_at?: string;
    todos?: { content: string; status: string }[];
    blocked?: BlockedInfo;
    deferred_steps?: string[];
    blocked_steps?: string[];
    remaining_runnable_steps?: string[];
    goal?: GoalSupervisionView;
    execution?: ExecutionSupervisionView;
    history?: GoalHistoryEvent[];
  }> {
    const view = await this.loadView(sessionId);
    const status = await this.statusOf(sessionId, view);
    // A status read must not mutate anything. It deliberately does NOT release
    // the workspace lock, write the Goal store, move the poll cursor, or clean
    // up temp resources; those belong to the goal-driving and wait paths, which
    // are annotated as write-capable.
    const pending = view.agent !== undefined
      ? { nextTurn: view.agent.inbox.nextTurn.length, nextStep: view.agent.inbox.nextStep.length }
      : foldPendingMessages(view.events);
    const span = lastTurnSpan(view.events);
    return {
      session_id: sessionId,
      status,
      live: view.agent !== undefined,
      ...(view.agent === undefined ? {} : { agent_status: view.agent.status }),
      pending,
      waiting: this.waitingFor(sessionId, view.events),
      ...(span === undefined ? {} : { last_turn: { turn: span.turn, ...(span.reason === undefined ? {} : { reason: span.reason.kind }) } }),
      updated_at: lastEventTime(view.events),
      ...this.goalFields(sessionId, view, status, { readOnly: true }),
    };
  }

  // ── Goal Supervision ──────────────────────────────────────────────────────

  async createGoal(input: {
    workspace: string;
    goal: string;
    plan?: string;
    execution_mode?: ExecutionMode;
    constraints?: GoalConstraints;
    request_id?: string;
    workspace_lock_override?: boolean;
  }): Promise<GoalStartResult> {
    return this.startGoal(input);
  }

  async reviseGoal(input: {
    session_id: string;
    goal?: string;
    plan?: string;
    execution_mode?: ExecutionMode;
    constraints?: GoalConstraints;
    expected_revision?: number;
    revision_reason?: string;
    request_id?: string;
    workspace_lock_override?: boolean;
  }): Promise<GoalStartResult> {
    return this.updateGoal({
      ...input,
      action: 'revise',
    });
  }

  async pauseGoal(sessionId: string): Promise<{
    session_id: string;
    status: BridgeStatus;
    paused: boolean;
    checkpoint_revision: number;
  }> {
    this.adopt(sessionId);
    const agent = this.ctx.agents.get(SessionId(sessionId));
    if (agent !== undefined && agent.status === 'running') {
      agent.cancel({ kind: 'user' });
    }
    const record = this.goalStore.get(sessionId);
    const view = await this.loadView(sessionId);
    const status = await this.statusOf(sessionId, view);
    return {
      session_id: sessionId,
      status,
      paused: true,
      checkpoint_revision: record?.revision ?? 1,
    };
  }

  async resumeGoal(
    sessionId: string,
    resumeSteps?: string[],
    requestId?: string,
    workspaceLockOverride?: boolean,
  ): Promise<GoalStartResult> {
    return this.updateGoal({
      session_id: sessionId,
      action: 'resume',
      resume_steps: resumeSteps,
      request_id: requestId,
      workspace_lock_override: workspaceLockOverride,
    });
  }

  async retryStep(
    sessionId: string,
    stepId: string,
    requestId?: string,
    workspaceLockOverride?: boolean,
  ): Promise<GoalStartResult> {
    this.adopt(sessionId);
    const record = this.goalStore.get(sessionId);
    if (record !== undefined && record.active_blockers) {
      record.active_blockers = record.active_blockers.filter((b) => b.step_id !== stepId);
      this.goalStore.put(record);
    }
    return this.updateGoal({
      session_id: sessionId,
      action: 'resume',
      resume_steps: [stepId],
      revision_reason: `retry_step_${stepId}`,
      request_id: requestId,
      workspace_lock_override: workspaceLockOverride,
    });
  }

  async rerunStep(
    sessionId: string,
    stepId: string,
    requestId?: string,
    workspaceLockOverride?: boolean,
  ): Promise<GoalStartResult> {
    this.adopt(sessionId);
    const view = await this.loadView(sessionId);
    const observed = this.observeGoal(sessionId, view, await this.statusOf(sessionId, view));
    const resolved = resolveStepRefs([stepId], observed.graph.steps);
    const resolvedKinds = new Set(resolved.kinds);
    const cacheKinds = uniqueStrings([
      ...resolved.contents.map((content) => idempotencyKindFor('', content) ?? ''),
      ...resolved.kinds.map((kind) => idempotencyKindFor(kind) ?? kind),
      idempotencyKindFor('', stepId) ?? '',
    ]);
    const record = this.goalStore.get(sessionId);
    if (record !== undefined) {
      record.completed_action_kinds = record.completed_action_kinds.filter((kind) => !resolvedKinds.has(kind));
      if (record.active_blockers) {
        const resolvedIds = new Set([stepId, ...resolved.ids, ...resolved.kinds]);
        record.active_blockers = record.active_blockers.filter((blocker) => !resolvedIds.has(blocker.step_id));
      }
      this.goalStore.put(record);
    }
    for (const kind of cacheKinds) this.idempotencyManager.invalidateKind(kind);
    return this.updateGoal({
      session_id: sessionId,
      action: 'revise',
      revision_reason: `rerun_step_${stepId}`,
      request_id: requestId,
      workspace_lock_override: workspaceLockOverride,
    });
  }

  async waitUntilActionRequired(sessionId: string, waitSeconds = 120): Promise<GoalWaitResult> {
    this.adopt(sessionId);
    const seconds = Math.min(300, Math.max(1, waitSeconds));
    const started = this.now();
    const deadline = started + seconds * 1000;
    let view = await this.loadView(sessionId);
    let status = await this.statusOf(sessionId, view);

    while (isActiveStatus(status) && this.now() < deadline) {
      const remaining = deadline - this.now();
      if (remaining <= 0) break;
      await this.sleep(Math.min(WAIT_POLL_MS, remaining));
      view = await this.loadView(sessionId);
      status = await this.statusOf(sessionId, view);
      if (!isActiveStatus(status)) break;
    }
    return this.goalSnapshot(sessionId, view, status, this.now() - started, seconds);
  }

  async getStructuredResult(sessionId: string): Promise<ResultSchema> {
    this.adopt(sessionId);
    const view = await this.loadView(sessionId);
    const status = await this.statusOf(sessionId, view);
    const record = this.goalStore.get(sessionId);
    const workspace = view.header?.cwd ?? '';
    const warnings: string[] = [];
    if (record?.history) {
      for (const event of record.history) {
        if (event.metadata?.reason === 'WORKSPACE_DRIFT') {
          const details = typeof event.metadata.details === 'string'
            ? event.metadata.details
            : 'Workspace drift detected';
          warnings.push(details);
        }
      }
    }
    const lastMutation = workspace === '' ? undefined : this.workspaceGuard.getLastMutation(workspace);
    return buildResultSchema({
      sessionId,
      record,
      events: view.events,
      status,
      workspace,
      evidenceIds: this.idempotencyManager.listEvidence({ sessionId }).map((item) => item.evidenceId),
      credentialRefs: this.getCredentialStatus()
        .filter((item) => item.credentialAvailable)
        .map((item) => item.credentialRef),
      originatingStep: lastMutation?.stepId ?? lastMutation?.type,
      warnings,
    });
  }

  getCredentialStatus(): CredentialStatus[] {
    const home = this.cfg.dshHome;
    let runtimeKeyConfigured = false;
    if (typeof home === 'string' && home !== '') {
      try {
        runtimeKeyConfigured = new SecretStore(home).runtimeApiKeyConfigured();
      } catch {
        runtimeKeyConfigured = false;
      }
    }
    return inspectCredentials({
      env: process.env,
      ...(typeof home === 'string' && home !== '' ? { dshHome: home } : {}),
      runtimeKeyConfigured,
    });
  }

  async startGoal(input: {
    workspace: string;
    goal: string;
    plan?: string;
    session_id?: string;
    request_id?: string;
    execution_mode?: ExecutionMode;
    constraints?: GoalConstraints;
    expected_revision?: number;
    workspace_lock_override?: boolean;
  }): Promise<GoalStartResult> {
    if (input.goal.trim() === '') throw new BridgeError('EMPTY_GOAL', 'goal must not be empty');

    // 1. Static Preflight Validation
    const preflight = validateGoalPreflight({
      goal: input.goal,
      plan: input.plan,
      constraints: input.constraints,
      mode: input.execution_mode,
    });
    if (!preflight.valid) {
      throw new BridgeError(
        'GOAL_INVALID',
        `Goal contradicts constraints: ${preflight.conflicts.join('; ')}`,
      );
    }

    const fingerprint = fingerprintStart(input);
    if (input.request_id !== undefined && input.request_id !== '') {
      const existing = this.goalRequests.get(input.request_id);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          throw new BridgeError(
            'REQUEST_ID_CONFLICT',
            `request_id "${input.request_id}" was already used with different start_goal arguments`,
          );
        }
        this.adopt(existing.sessionId);
        const view = await this.loadView(existing.sessionId);
        return {
          ...(await this.mapGoalStart(existing.sessionId, view)),
          existing_goal_reused: true,
          revision_unchanged: true,
        };
      }
    }

    let sessionId = input.session_id;
    const resolvedWorkspace = await this.resolveWorkspace(input.workspace);
    const workspacePath = resolvedWorkspace.path;
    const isReadOnly = input.constraints?.read_only === true;
    const lockOverride = input.workspace_lock_override === true;

    if (sessionId === undefined || sessionId === '') {
      // Check if there is an active session on this workspace with identical Goal
      const activeSessions = this.ctx.agents.list();
      let reusedSessionId: string | undefined;
      for (const agent of activeSessions) {
        const record = this.goalStore.get(agent.id);
        if (record !== undefined && pathsEqual(agent.session.header?.cwd ?? '', workspacePath)) {
          const view = await this.loadView(agent.id);
          const status = await this.statusOf(agent.id, view);
          if (!isActiveStatus(status) && !isWaitingStatus(status)) continue;
          if (isGoalSemanticallyEqual(record, input.goal, input.plan, input.execution_mode, input.constraints)) {
            reusedSessionId = agent.id;
            break;
          }
        }
      }

      if (reusedSessionId !== undefined) {
        sessionId = reusedSessionId;
        this.adopt(sessionId);
        const view = await this.loadView(sessionId);
        return {
          ...(await this.mapGoalStart(sessionId, view)),
          existing_goal_reused: true,
          revision_unchanged: true,
        };
      }

      this.assertMutableWorkspaceAvailable(workspacePath, undefined, lockOverride, isReadOnly);
      const created = await this.createSession(input.workspace, titleFromGoal(input.goal));
      sessionId = created.session_id;
    } else {
      this.adopt(sessionId);
    }

    const existingRecord = this.goalStore.get(sessionId);
    if (
      input.expected_revision !== undefined
      && existingRecord !== undefined
      && input.expected_revision !== existingRecord.revision
    ) {
      throw new BridgeError(
        'REVISION_CONFLICT',
        `expected_revision mismatch: expected ${input.expected_revision}, but current revision is ${existingRecord.revision}`,
      );
    }

    await this.takeWorkspaceLock(workspacePath, sessionId, lockOverride, isReadOnly);

    // 3. Goal Deduplication on existing session
    if (
      existingRecord !== undefined &&
      isGoalSemanticallyEqual(existingRecord, input.goal, input.plan, input.execution_mode, input.constraints)
    ) {
      if (input.request_id !== undefined && input.request_id !== '') {
        this.goalRequests.set(input.request_id, { sessionId, fingerprint });
      }
      const view = await this.loadView(sessionId);
      return {
        ...(await this.mapGoalStart(sessionId, view)),
        existing_goal_reused: true,
        revision_unchanged: true,
      };
    }

    const record = this.applyStartOrRevise(sessionId, input);
    // Goal metadata is stated in durable text and reconciled against the
    // transcript, so a goal message must keep the plain followup delivery that
    // manual queue management can also see: one queue, one order.
    await this.deliverMessage(
      sessionId,
      this.controlMessage(record, input.goal, input.plan, record.revision === 1 ? 'start' : 'revise'),
      'followup',
    );
    if (input.request_id !== undefined && input.request_id !== '') {
      this.goalRequests.set(input.request_id, { sessionId, fingerprint });
    }
    const view = await this.loadView(sessionId);
    return this.mapGoalStart(sessionId, view);
  }

  async updateGoal(input: {
    session_id: string;
    action?: 'revise' | 'defer' | 'resume';
    goal?: string;
    plan?: string;
    execution_mode?: ExecutionMode;
    constraints?: GoalConstraints;
    expected_revision?: number;
    defer_steps?: string[];
    resume_steps?: string[];
    revision_reason?: string;
    request_id?: string;
    workspace?: string;
    workspace_lock_override?: boolean;
  }): Promise<GoalStartResult> {
    const sessionId = input.session_id;
    if (sessionId.trim() === '') throw new BridgeError('SESSION_REQUIRED', 'dsh_update_goal requires session_id');
    const action = input.action ?? 'revise';
    const fingerprint = fingerprintStart({
      workspace: input.workspace ?? '',
      goal: input.goal ?? '',
      plan: input.plan,
      session_id: sessionId,
      execution_mode: input.execution_mode,
      constraints: input.constraints,
      action,
    });
    if (input.request_id !== undefined && input.request_id !== '') {
      const existing = this.goalRequests.get(input.request_id);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          throw new BridgeError(
            'REQUEST_ID_CONFLICT',
            `request_id "${input.request_id}" was already used with different update_goal arguments`,
          );
        }
        this.adopt(existing.sessionId);
        const view = await this.loadView(existing.sessionId);
        return {
          ...(await this.mapGoalStart(existing.sessionId, view)),
          existing_goal_reused: true,
          revision_unchanged: true,
        };
      }
    }
    this.adopt(sessionId);
    await this.ensureAgent(sessionId);
    const current = this.goalStore.get(sessionId);
    if (action === 'resume' && current === undefined) {
      throw new BridgeError('GOAL_NOT_FOUND', `no supervised goal on session ${sessionId}; resume will not create one`);
    }

    if (input.expected_revision !== undefined && current !== undefined && input.expected_revision !== current.revision) {
      throw new BridgeError(
        'REVISION_CONFLICT',
        `expected_revision mismatch: expected ${input.expected_revision}, but current revision is ${current.revision}`,
      );
    }

    const viewBefore = await this.loadView(sessionId);
    const workspacePath = viewBefore.header?.cwd ?? '';
    const isReadOnly = (input.constraints?.read_only ?? current?.constraints?.read_only) === true;
    const lockOverride = input.workspace_lock_override === true;
    if (workspacePath !== '') {
      this.assertMutableWorkspaceAvailable(workspacePath, sessionId, lockOverride, isReadOnly);
      await this.takeWorkspaceLock(workspacePath, sessionId, lockOverride, isReadOnly);
    }
    const observed = this.observeGoal(sessionId, viewBefore, await this.statusOf(sessionId, viewBefore));
    const resolvedDefer = input.defer_steps === undefined
      ? { ids: [] as string[], kinds: [] as ActionKind[] }
      : resolveStepRefs(input.defer_steps, observed.graph.steps);
    const resolvedResume = input.resume_steps === undefined
      ? { ids: action === 'resume' ? [...(current?.deferred_step_ids ?? [])] : [], kinds: [] as ActionKind[] }
      : resolveStepRefs(input.resume_steps, observed.graph.steps);
    const detected = detectDeferredKinds(input.goal ?? current?.goal ?? '', input.plan ?? current?.plan);
    const deferIds = uniqueStrings([
      ...resolvedDefer.ids,
      ...resolvedDefer.kinds,
      ...detected,
      ...(action === 'defer' ? (input.defer_steps ?? []) : []),
    ]);
    const resumeIds = uniqueStrings([...resolvedResume.ids, ...resolvedResume.kinds]);
    let record = current ?? createGoalRecord({
      sessionId,
      goal: input.goal ?? 'continued goal',
      plan: input.plan,
      mode: parseExecutionMode(input.execution_mode),
      constraints: parseConstraints(input.constraints),
      now: this.now(),
    });
    if (current === undefined) this.goalStore.put(record);
    record = applyRevision(record, {
      ...(input.goal === undefined ? {} : { goal: input.goal }),
      ...(input.plan === undefined ? {} : { plan: input.plan }),
      ...(input.execution_mode === undefined ? {} : { mode: parseExecutionMode(input.execution_mode) }),
      ...(input.constraints === undefined ? {} : { constraints: parseConstraints(input.constraints) }),
      ...(input.expected_revision === undefined ? {} : { expectedRevision: input.expected_revision }),
      ...(deferIds.length === 0 ? {} : { deferredStepIds: deferIds }),
      ...(action === 'resume' ? { resumeStepIds: resumeIds } : {}),
      completedActionKinds: [...successfulKinds(observed.facts)],
      revisionReason: input.revision_reason ?? (
        action === 'resume' ? 'user_resumed_goal' : action === 'defer' ? 'user_deferred_step' : 'user_modified_goal'
      ),
      now: this.now(),
    }, action === 'resume' ? 'goal_resumed' : 'goal_revised');
    pruneBlockers(record, successfulKinds(observed.facts));
    this.goalStore.put(record);
    const intent = action === 'resume' ? 'resume' : action === 'defer' ? 'defer' : 'revise';
    await this.deliverMessage(sessionId, this.controlMessage(
      record,
      input.goal ?? record.goal,
      input.plan ?? record.plan,
      intent,
      resumeIds,
    ), 'followup');
    if (input.request_id !== undefined && input.request_id !== '') {
      this.goalRequests.set(input.request_id, { sessionId, fingerprint });
    }
    const view = await this.loadView(sessionId);
    return this.mapGoalStart(sessionId, view);
  }

  async waitGoal(sessionId: string, waitSeconds?: number): Promise<GoalWaitResult> {
    this.adopt(sessionId);
    const seconds = clampWaitSeconds(waitSeconds);
    const started = this.now();
    const deadline = started + seconds * 1000;
    let view = await this.loadView(sessionId);
    let status = await this.statusOf(sessionId, view);
    while (isActiveStatus(status) && this.now() < deadline) {
      const remaining = deadline - this.now();
      if (remaining <= 0) break;
      await this.sleep(Math.min(WAIT_POLL_MS, remaining));
      view = await this.loadView(sessionId);
      status = await this.statusOf(sessionId, view);
    }
    return this.goalSnapshot(sessionId, view, status, this.now() - started, seconds);
  }

  async stopGoal(sessionId: string): Promise<{
    session_id: string;
    stopped: true;
    already_stopped: boolean;
    status: BridgeStatus;
    cleanup_warning?: string;
  }> {
    this.adopt(sessionId);
    this.workspaceGuard.releaseLock(sessionId);
    const view = await this.loadView(sessionId);
    const status = await this.statusOf(sessionId, view);
    if (isTerminalStatus(status) || status === 'unknown' || (status === 'idle' && view.agent === undefined)) {
      const warning = this.cleanupGoalTemps(sessionId, view);
      return {
        session_id: sessionId,
        stopped: true,
        already_stopped: true,
        status,
        ...(warning === undefined ? {} : { cleanup_warning: warning }),
      };
    }
    if (status === 'idle' && view.agent !== undefined && !isActiveStatus(status)) {
      const warning = this.cleanupGoalTemps(sessionId, view);
      return {
        session_id: sessionId,
        stopped: true,
        already_stopped: true,
        status,
        ...(warning === undefined ? {} : { cleanup_warning: warning }),
      };
    }
    await this.failClosedWaiting(sessionId);
    const agent = this.ctx.agents.get(SessionId(sessionId));
    if (agent !== undefined) agent.cancel({ kind: 'user' });
    const warning = this.cleanupGoalTemps(sessionId, view);
    this.noteGoalEvent(sessionId, 'goal_cancelled');
    return {
      session_id: sessionId,
      stopped: true,
      already_stopped: false,
      status: 'cancelled',
      ...(warning === undefined ? {} : { cleanup_warning: warning }),
    };
  }

  private async failClosedWaiting(sessionId: string): Promise<void> {
    for (const pending of [...this.approvals.values()]) {
      if (pending.sessionId !== sessionId) continue;
      this.approvals.delete(pending.id);
      let settled = false;
      if (pending.muxRpcId !== undefined && this.apiProxy !== undefined) {
        try {
          const receipt = await respondApproval(this.apiProxy, pending.muxRpcId, sessionId, pending.id, 'rejected');
          settled = receipt.accepted;
        } catch {
          settled = false;
        }
      }
      if (!settled) pending.resolve('cancelled');
      else pending.resolve('rejected');
    }
    for (const pending of [...this.questions.values()]) {
      if (pending.sessionId !== sessionId) continue;
      this.questions.delete(pending.id);
      if (pending.muxRpcId !== undefined && this.apiProxy !== undefined) {
        try {
          await cancelQuestion(this.apiProxy, pending.muxRpcId);
        } catch {
          // local fail-closed below
        }
      }
      pending.resolve({ answers: [] });
    }
  }

  private applyStartOrRevise(sessionId: string, input: {
    goal: string;
    plan?: string;
    execution_mode?: ExecutionMode;
    constraints?: GoalConstraints;
    expected_revision?: number;
  }): GoalRecord {
    const existing = this.goalStore.get(sessionId);
    const mode = parseExecutionMode(input.execution_mode);
    const constraints = parseConstraints(input.constraints);
    const detected = detectDeferredKinds(input.goal, input.plan);
    if (existing === undefined) {
      const created = createGoalRecord({
        sessionId,
        goal: input.goal,
        plan: input.plan,
        mode,
        constraints,
        now: this.now(),
        revisionReason: 'goal_created',
      });
      if (detected.length > 0) created.deferred_step_ids = [...new Set(detected)];
      return this.goalStore.put(created);
    }
    return this.goalStore.put(applyRevision(existing, {
      goal: input.goal,
      plan: input.plan,
      mode,
      constraints,
      ...(input.expected_revision === undefined ? {} : { expectedRevision: input.expected_revision }),
      deferredStepIds: detected,
      revisionReason: 'user_modified_goal',
      now: this.now(),
    }, 'goal_revised'));
  }

  private controlMessage(
    record: GoalRecord,
    goal: string,
    plan: string | undefined,
    intent: 'start' | 'revise' | 'resume' | 'defer',
    resumeSteps?: string[],
  ): string {
    return buildSupervisedGoalContext(record, goal, plan, intent, resumeSteps);
  }

  private async mapGoalStart(sessionId: string, view: LoadedView): Promise<GoalStartResult> {
    const status = await this.statusOf(sessionId, view);
    this.releaseWorkspaceIfTerminal(sessionId, status);
    const observed = this.observeGoal(sessionId, view, status);
    const record = applyNativeGetGoalResult(this.goalStore.get(sessionId), undefined);
    const currentStep = observed.blocked?.step
      ?? observed.graph.steps.find((step) => step.status === 'in_progress' || step.status === 'ready')?.content
      ?? observed.graph.remaining_runnable_steps[0];
    return mapStartGoal(sessionId, status, DEFAULT_WAIT_SECONDS, {
      ...(record === undefined ? {} : { goal: supervisionGoal(record) }),
      execution: executionView(observed.graph, currentStep),
      ...(record === undefined ? {} : { history: sliceHistory(record.history) }),
    });
  }

  private noteGoalEvent(
    sessionId: string,
    type: GoalHistoryEvent['type'],
    extra?: { step_id?: string; metadata?: Record<string, unknown> },
  ): void {
    const record = this.goalStore.get(sessionId);
    if (record === undefined) return;
    this.goalStore.put(appendGoalEvent(record, type, { ...extra, now: this.now() }));
  }

  /**
   * Decide a DSH approval/request for a managed session.
   * Idempotent high-cost steps are skipped; L0/L1 may auto-approve;
   * deny/reject always remain reachable even if approve is blocked.
   */
  async decideApproval(
    request: ApprovalRequestLike,
    next: () => Promise<ApprovalOutcome> | ApprovalOutcome = () => Promise.resolve('rejected' as ApprovalOutcome),
  ): Promise<ApprovalOutcome> {
    if (!this.managed.has(request.agent.id)) return next();

    const command = commandForCall(request.agent.session?.snapshotEvents?.(), request.callId);
    const workspacePath = request.agent.session?.header?.cwd
      ?? this.workspaceBaselines.get(request.agent.id)?.workspacePath;
    const writeOperation = classesForTool(request.toolName, command).includes('filesystem.write');
    const targetPaths = filePathsForCall(request.agent.session?.snapshotEvents?.(), request.callId);
    const externalWrite = writeOperation && (
      workspacePath === undefined
      || targetPaths.length === 0
      || targetPaths.some((path) => !isPathInsideWorkspace(path, workspacePath))
    );
    const evalDecision = evaluateApproval(
      request.toolName,
      command,
      this.approvalPolicy,
      { externalWrite },
    );
    if (workspacePath !== undefined && workspacePath !== '') {
      this.recordObservedExecutionFacts(
        request.agent.id,
        workspacePath,
        foldGoalFacts((request.agent.session?.snapshotEvents?.() ?? []) as readonly LooseEvent[]),
      );
      await this.refreshWorkspaceBaselineIfNeeded(request.agent.id, workspacePath);
    }
    const baseline = this.workspaceBaselines.get(request.agent.id);
    const mutatingOperation = isMutatingTool(request.toolName, command);
    const needsCurrentSnapshot = mutatingOperation
      || idempotencyKindFor(request.toolName, command) !== undefined;
    const currentSnapshot = workspacePath !== undefined && workspacePath !== '' && needsCurrentSnapshot
      ? await this.workspaceGuard.captureBaseline(workspacePath)
      : undefined;

    if (workspacePath && baseline && mutatingOperation) {
      const drift = await this.workspaceGuard.detectDrift(
        workspacePath,
        baseline,
        request.agent.id,
        currentSnapshot,
      );
      if (drift.drifted) {
        this.log.warn(`Workspace drift detected on ${request.agent.id}: ${drift.details}`);
        this.noteGoalEvent(request.agent.id, 'constraint_rejected', {
          metadata: {
            reason: 'WORKSPACE_DRIFT',
            details: drift.details,
            originating_session_id: drift.originatingSessionId,
          },
        });
        return 'rejected' as ApprovalOutcome;
      }
    }

    if (workspacePath !== undefined && workspacePath !== '') {
      const skip = this.skipIdempotentStep(
        request.agent.id,
        request.toolName,
        command,
        workspacePath,
        currentSnapshot ?? baseline,
        request.callId,
      );
      if (skip !== undefined) return 'rejected' as ApprovalOutcome;
    }

    // A proven no-op replay is safe to fold before the normal constraint
    // rejection path. New work still goes through constraints and approval.
    if (this.rejectConstraint(request)) return 'rejected' as ApprovalOutcome;

    if (evalDecision.decision === 'auto_approve') {
      if (workspacePath && mutatingOperation) {
        this.noteMutation(workspacePath, request.agent.id, request.toolName, command, request.callId);
      }
      this.log.info(`auto-approving L0/L1 tool ${request.toolName} (capability ${evalDecision.capability}) for session ${request.agent.id}`);
      return 'approved' as ApprovalOutcome;
    }
    if (evalDecision.decision === 'deny') {
      this.log.info(`policy denied tool ${request.toolName} (capability ${evalDecision.capability}) for session ${request.agent.id}: ${evalDecision.reason}`);
      this.noteGoalEvent(request.agent.id, 'constraint_rejected', {
        metadata: {
          reason: evalDecision.reason,
          tool: request.toolName,
          layer: 'bridge_policy' satisfies ApprovalLayer,
          capability: evalDecision.capability,
        },
      });
      return 'rejected' as ApprovalOutcome;
    }

    if (this.webOwnsApprovals) return next();
    const id = `approval-${randomUUID()}`;
    const pending: PendingApproval = {
      id,
      sessionId: request.agent.id,
      toolName: request.toolName,
      callId: request.callId,
      reason: request.reason,
      command,
      capability: evalDecision.capability,
      level: evalDecision.level,
      resolve: () => {},
    };
    const decision = new Promise<ApprovalOutcome>((resolve) => {
      pending.resolve = resolve;
    });
    this.approvals.set(id, pending);
    this.noteGoalEvent(request.agent.id, 'approval_requested', {
      metadata: {
        tool: request.toolName,
        approval_id: id,
        capability: evalDecision.capability,
        level: evalDecision.level,
        command,
        layer: 'user' satisfies ApprovalLayer,
      },
    });
    this.log.info(`approval ${id} pending for session ${request.agent.id} (tool ${request.toolName}, level ${evalDecision.level})`);
    request.signal?.addEventListener(
      'abort',
      () => {
        if (this.approvals.delete(id)) {
          this.log.info(`approval ${id} withdrawn (turn aborted)`);
          pending.resolve('cancelled');
        }
      },
      { once: true },
    );
    return decision;
  }

  private rejectConstraint(request: {
    agent: { id: string; session?: { snapshotEvents?: () => readonly SessionEvent[] } };
    toolName: string;
    callId?: string;
  }): boolean {
    const record = this.goalStore.get(request.agent.id);
    if (record === undefined) return false;
    const hasRules = Object.keys(record.constraints).length > 0 || record.completed_action_kinds.length > 0;
    if (!hasRules) return false;
    const command = commandForCall(request.agent.session?.snapshotEvents?.(), request.callId);
    const changed = changedFileCountOf(request.agent.session?.snapshotEvents?.());
    const decision = evaluateConstraint({
      constraints: record.constraints,
      completedKinds: record.completed_action_kinds,
      changedFileCount: changed,
      toolName: request.toolName,
      command,
    });
    if (decision.allow) return false;
    this.goalStore.put(appendGoalEvent(record, 'constraint_rejected', {
      now: this.now(),
      ...(decision.kind === undefined ? {} : { step_id: decision.kind }),
      metadata: {
        reason: decision.reason,
        tool: request.toolName,
        ...(decision.action_class === undefined ? {} : { action_class: decision.action_class }),
      },
    }));
    this.log.info(`constraint rejected ${request.toolName} on ${request.agent.id}: ${decision.reason}`);
    return true;
  }

  private observeGoal(
    sessionId: string,
    view: LoadedView,
    status: BridgeStatus,
    options: { readOnly?: boolean } = {},
  ) {
    const facts = foldGoalFacts(view.events);
    // A read-only observation must not record execution evidence, refresh a
    // workspace baseline, or write the Goal store; it only derives a view.
    if (options.readOnly !== true) this.recordObservedExecutions(sessionId, view, facts);
    let record = this.goalStore.get(sessionId);
    const succeeded = [...successfulKinds(facts)];
    if (
      options.readOnly !== true
      && record !== undefined
      && succeeded.some((kind) => !record!.completed_action_kinds.includes(kind))
    ) {
      record = {
        ...record,
        completed_action_kinds: [...new Set([...record.completed_action_kinds, ...succeeded])],
      };
      this.goalStore.put(record);
    }
    const isHeld = status === 'waiting_for_approval' || status === 'waiting_for_user' || status === 'blocked';
    const waitingKinds = isHeld
      ? (() => {
          const kind = inferBlockedKind(facts, status);
          return kind === undefined ? [] : [kind];
        })()
      : [];
    const todos = reconcileTodos({
      ...(facts.todos === undefined ? {} : { todos: facts.todos }),
      facts,
      waitingKinds,
      holdInProgress: isHeld,
    });
    const blockedKind = inferBlockedKind(facts, status);
    const deferredKinds = deferredKindsOf(record?.deferred_step_ids);
    const graph = buildGoalGraph({
      ...(todos === undefined ? {} : { todos }),
      ...(record?.plan === undefined ? {} : { plan: record.plan }),
      facts,
      deferredKinds,
      ...(record === undefined ? {} : { deferredStepIds: record.deferred_step_ids }),
      ...(blockedKind === undefined ? {} : { blockedKind }),
      ...(status === 'waiting_for_user' || status === 'waiting_for_approval' ? { waitingStatus: status } : {}),
    });
    const waiting = this.waitingFor(sessionId, view.events);
    let blocked = describeBlocked({
      status,
      facts,
      graph,
      approval: waiting.approvals[0],
      question: waiting.questions[0],
    });
    if (record !== undefined) {
      const violation = findPostHocViolation(facts, record.constraints);
      if (violation !== undefined) {
        blocked = {
          step: violation.step,
          reason: 'constraint_rejected',
          resume_condition: `Constraint ${violation.reason} rejected this action. Revise constraints or the goal, then resume.`,
          scope: graph.remaining_runnable_steps.length > 0 ? 'step' : 'goal',
          independent_steps_available: graph.remaining_runnable_steps.length > 0,
        };
      }
    }
    return { facts, todos, graph, blocked, waiting, record };
  }

  private goalFields(
    sessionId: string,
    view: LoadedView,
    status: BridgeStatus,
    options: { readOnly?: boolean } = {},
  ): {
    todos?: { content: string; status: string }[];
    blocked?: BlockedInfo;
    deferred_steps?: string[];
    blocked_steps?: string[];
    remaining_runnable_steps?: string[];
    goal?: GoalSupervisionView;
    execution?: ExecutionSupervisionView;
    history?: GoalHistoryEvent[];
  } {
    const { todos, graph, blocked, record: observedRecord } = this.observeGoal(sessionId, view, status, options);
    const record = applyNativeGetGoalResult(observedRecord, undefined);
    const currentStep = blocked?.step
      ?? graph.steps.find((step) => step.status === 'in_progress' || step.status === 'ready')?.content
      ?? graph.remaining_runnable_steps[0];
    return {
      ...(todos === undefined ? {} : { todos }),
      ...(blocked === undefined ? {} : { blocked }),
      ...(graph.deferred_steps.length === 0 ? {} : { deferred_steps: graph.deferred_steps }),
      ...(graph.blocked_steps.length === 0 ? {} : { blocked_steps: graph.blocked_steps }),
      ...(graph.remaining_runnable_steps.length === 0 ? {} : { remaining_runnable_steps: graph.remaining_runnable_steps }),
      ...(record === undefined ? {} : { goal: supervisionGoal(record) }),
      execution: executionView(graph, currentStep),
      ...(record === undefined ? {} : { history: sliceHistory(record.history) }),
    };
  }

  private cleanupGoalTemps(sessionId: string, view: LoadedView): string | undefined {
    const workspace = view.header.cwd;
    if (typeof workspace !== 'string' || workspace === '') return undefined;
    const facts = foldGoalFacts(view.events);
    const record = this.goalStore.get(sessionId);
    const resources = discoverTempResources({
      facts,
      sessionId,
      goalId: record?.goal_id ?? sessionId,
      workspacePath: workspace,
    });
    if (resources.length === 0) return undefined;
    const cleaned = cleanupTempResources(resources, workspace);
    if (cleaned.warnings.length === 0) return undefined;
    return cleaned.warnings.join('; ');
  }

  private async goalSnapshot(
    sessionId: string,
    view: LoadedView,
    status: BridgeStatus,
    waitedMs: number,
    waitSeconds: number,
    options: { readOnly?: boolean } = {},
  ): Promise<GoalWaitResult> {
    const readOnly = options.readOnly === true;
    const { facts, todos, graph, blocked, waiting, record: observedRecord } = this.observeGoal(sessionId, view, status, options);
    const record = applyNativeGetGoalResult(observedRecord, undefined);
    const span = lastTurnSpan(view.events);
    const changedFiles = span === undefined ? [] : changedFilesForTurn(view.events, span.turn);
    const errorSummary = span?.reason !== undefined && span.reason.kind === 'error'
      ? `${span.reason.error.code}: ${span.reason.error.message}`
      : undefined;
    const currentStep = blocked?.step
      ?? graph.steps.find((step) => step.status === 'in_progress')?.content
      ?? graph.remaining_runnable_steps[0];
    const approvalIds = waiting.approvals.map((item) => item.approval_id);
    const questionIds = waiting.questions.map((item) => item.question_id);
    const deltaInput = {
      events: view.events,
      facts,
      ...(todos === undefined ? {} : { todos }),
      status,
      changedFiles,
      ...(view.agent === undefined ? {} : { agentStatus: view.agent.status }),
      approvalIds,
      questionIds,
      previous: this.pollCursors.get(sessionId),
      ...(currentStep === undefined ? {} : { currentStep }),
    };
    const progressDelta = computeProgressDelta(deltaInput);
    // The poll cursor is progress-reporting state; a read-only snapshot must not
    // advance it, or a later real wait would under-report its delta.
    if (!readOnly) this.pollCursors.set(sessionId, nextPollCursor(deltaInput));
    const mapped = mapWaitGoal({
      sessionId,
      status,
      waitedMs,
      waitSeconds,
      ...(todos === undefined ? {} : { todos }),
      lastActivity: lastEventTime(view.events),
      ...(span === undefined ? {} : { lastTurn: { turn: span.turn, ...(span.reason === undefined ? {} : { reason: span.reason.kind }) } }),
      changedFiles,
      assistantSummary: span === undefined ? '' : assistantTextForTurn(view.events, span.turn),
      ...(errorSummary === undefined ? {} : { errorSummary }),
      ...(view.agent === undefined ? {} : { agentStatus: view.agent.status }),
      approval: waiting.approvals[0],
      question: waiting.questions[0],
      progressDelta,
      ...(blocked === undefined ? {} : { blocked }),
      deferredSteps: graph.deferred_steps,
      blockedSteps: graph.blocked_steps,
      remainingRunnableSteps: graph.remaining_runnable_steps,
      ...(record === undefined ? {} : { goal: supervisionGoal(record) }),
      execution: executionView(graph, currentStep),
      ...(record === undefined ? {} : { history: sliceHistory(record.history) }),
    });
    if (
      !readOnly
      && mapped.terminal
      && record !== undefined
      && (status === 'completed' || status === 'cancelled' || status === 'failed')
    ) {
      const already = record.history.some((event) => event.type === 'goal_completed' || event.type === 'goal_cancelled');
      if (!already) {
        this.goalStore.put(appendGoalEvent(record, status === 'cancelled' ? 'goal_cancelled' : 'goal_completed', { now: this.now() }));
      }
    }
    // Terminal bookkeeping (lock release, temp cleanup) is a side effect and is
    // skipped entirely for a read-only snapshot.
    if (readOnly) return mapped;
    this.releaseWorkspaceIfTerminal(sessionId, status);
    if (!mapped.terminal) return mapped;
    const warning = this.cleanupGoalTemps(sessionId, view);
    return warning === undefined ? mapped : { ...mapped, cleanup_warning: warning };
  }

  // ── user questions / approvals ────────────────────────────────────────────

  async answerQuestion(questionId: string, sessionId: string | undefined, answer: {
    selected: string[];
    custom?: string;
  }): Promise<{ answered: true }> {
    const pending = [...this.questions.values()].find(
      (item) => (item.id === questionId || item.callId === questionId) && (sessionId === undefined || item.sessionId === sessionId),
    );
    if (pending === undefined) {
      throw new BridgeError('QUESTION_NOT_FOUND', `no pending question ${questionId}`);
    }
    const question = pending.questions[0];
    const labels = new Set(question?.options?.map((option) => option.label) ?? []);
    if (answer.selected.some((label) => !labels.has(label))) {
      throw new BridgeError('INVALID_ANSWER', `selected option(s) are not offered by question ${questionId}`);
    }
    if (question?.multiSelect !== true && answer.selected.length > 1) {
      throw new BridgeError('INVALID_ANSWER', `question ${questionId} is single-select`);
    }
    this.questions.delete(pending.id);
    if (pending.callId !== undefined) this.questions.delete(pending.callId);
    const resolved: AskUserQuestionAnswer = {
      answers: [
        {
          id: pending.questions[0]?.id ?? questionId,
          selected: answer.selected,
          ...(answer.custom === undefined ? {} : { custom: answer.custom }),
        },
      ],
    };
    if (pending.muxRpcId !== undefined && this.apiProxy !== undefined && pending.sessionId !== undefined) {
      const receipt = await respondQuestion(this.apiProxy, pending.muxRpcId, pending.sessionId, resolved);
      if (!receipt.accepted) {
        throw new BridgeError('QUESTION_NOT_FOUND', `Web gateway rejected answer for ${questionId}: ${receipt.reason ?? 'not-pending'}`);
      }
    } else {
      pending.resolve(resolved);
    }
    this.log.info(`question ${questionId} answered`);
    if (pending.sessionId !== undefined) {
      this.noteGoalEvent(pending.sessionId, 'question_answered', { metadata: { question_id: questionId } });
    }
    return { answered: true };
  }

  async approve(sessionId: string, approvalId: string, decision: 'approve' | 'reject'): Promise<{
    approval_id: string;
    session_id: string;
    decision: 'approve' | 'reject';
    outcome: ApprovalOutcome;
    layer: ApprovalLayer;
    fail_closed?: boolean;
  }> {
    const pending = this.approvals.get(approvalId);
    if (pending === undefined) {
      throw new BridgeError('APPROVAL_NOT_FOUND', `no pending approval ${approvalId}`);
    }
    if (pending.sessionId !== sessionId) {
      throw new BridgeError('APPROVAL_SESSION_MISMATCH', `approval ${approvalId} belongs to session ${pending.sessionId}`);
    }
    const outcome: ApprovalOutcome = decision === 'approve' ? 'allowed-once' : 'rejected';
    if (pending.muxRpcId !== undefined && this.apiProxy !== undefined) {
      const receipt = await respondApproval(this.apiProxy, pending.muxRpcId, sessionId, approvalId, outcome);
      if (!receipt.accepted) {
        if (decision === 'approve') {
          throw new BridgeError(
            'APPROVAL_UNREACHABLE',
            `approve is blocked by the platform security layer for ${approvalId}: ${receipt.reason ?? 'not-pending'}. reject or dsh_stop_goal remains reachable.`,
            {
              layer: 'platform' satisfies ApprovalLayer,
              reject_reachable: true,
              cancel_reachable: true,
              approval_id: approvalId,
            },
          );
        }
        this.approvals.delete(approvalId);
        pending.resolve('rejected');
        this.noteGoalEvent(sessionId, 'approval_resolved', {
          metadata: { approval_id: approvalId, decision: 'reject', layer: 'platform' satisfies ApprovalLayer, fail_closed: true },
        });
        this.log.info(`approval ${approvalId} fail-closed rejected after platform blocked mux respond`);
        return {
          approval_id: approvalId,
          session_id: sessionId,
          decision: 'reject',
          outcome: 'rejected',
          layer: 'platform',
          fail_closed: true,
        };
      }
    } else {
      pending.resolve(outcome);
    }
    this.approvals.delete(approvalId);
    if (decision === 'approve') {
      const workspacePath = this.workspaceBaselines.get(sessionId)?.workspacePath;
      if (workspacePath && isMutatingTool(pending.toolName, pending.command)) {
        this.noteMutation(workspacePath, sessionId, pending.toolName, pending.command, pending.callId);
      }
    }
    this.log.info(`approval ${approvalId} decided: ${decision}`);
    this.noteGoalEvent(sessionId, 'approval_resolved', {
      metadata: { approval_id: approvalId, decision, layer: 'user' satisfies ApprovalLayer },
    });
    return { approval_id: approvalId, session_id: sessionId, decision, outcome, layer: 'user' };
  }

  private isLockHolderActive(sessionId: string): boolean {
    const holderAgent = this.ctx.agents.get(SessionId(sessionId));
    if (holderAgent === undefined) return false;
    if (holderAgent.status === 'running') return true;
    return holderAgent.inbox.nextTurn.length > 0 || holderAgent.inbox.nextStep.length > 0;
  }

  private workspaceLockedError(holder: { sessionId: string; goalId: string }): BridgeError {
    return new BridgeError(
      'WORKSPACE_LOCKED',
      `workspace is locked by session ${holder.sessionId} (goal ${holder.goalId}); waiting_for_workspace_lock. Pass workspace_lock_override=true to take over.`,
      {
        status: 'waiting_for_workspace_lock',
        holder_session_id: holder.sessionId,
        holder_goal_id: holder.goalId,
      },
    );
  }

  private assertMutableWorkspaceAvailable(
    workspacePath: string,
    sessionId: string | undefined,
    override: boolean,
    isReadOnly: boolean,
  ): void {
    if (isReadOnly || override) return;
    const existing = this.workspaceGuard.getLock(workspacePath);
    if (existing === undefined) return;
    if (sessionId !== undefined && existing.sessionId === sessionId) return;
    if (this.isLockHolderActive(existing.sessionId)) {
      throw this.workspaceLockedError(existing);
    }
  }

  private async takeWorkspaceLock(
    workspacePath: string,
    sessionId: string,
    override: boolean,
    isReadOnly: boolean,
  ): Promise<void> {
    if (isReadOnly) return;
    const existing = this.workspaceGuard.getLock(workspacePath);
    const holderActive = existing !== undefined && existing.sessionId !== sessionId
      ? this.isLockHolderActive(existing.sessionId)
      : false;
    const lockRes = this.workspaceGuard.acquireMutableLock(
      workspacePath,
      sessionId,
      `goal-${sessionId}`,
      holderActive,
      override,
    );
    if (!lockRes.success && lockRes.holder !== undefined) {
      throw this.workspaceLockedError(lockRes.holder);
    }
    if (lockRes.warning) this.log.warn(lockRes.warning);
    if (!this.workspaceBaselines.has(sessionId)) {
      const baseline = await this.workspaceGuard.captureBaseline(workspacePath);
      this.workspaceBaselines.set(sessionId, baseline);
    }
  }

  private releaseWorkspaceIfTerminal(sessionId: string, status: BridgeStatus): void {
    if (isTerminalStatus(status)) this.workspaceGuard.releaseLock(sessionId);
  }

  private skipIdempotentStep(
    sessionId: string,
    toolName: string,
    command: string | undefined,
    workspacePath: string,
    snapshot?: WorkspaceBaseline,
    callId?: string,
  ): { code: string; evidenceId: string } | undefined {
    const kind = idempotencyKindFor(toolName, command);
    if (kind === undefined) return undefined;
    const fingerprint = this.idempotencyManager.computeFingerprint({
      kind,
      command,
      workspacePath,
      headSha: snapshot?.headSha,
      extra: this.executionFingerprintExtra(snapshot),
    });
    const hit = this.idempotencyManager.check(fingerprint, { sessionId, workspacePath });
    if (hit === null) {
      if (callId !== undefined) {
        this.rememberPendingExecutionFingerprint(`${sessionId}:${callId}`, { kind, fingerprint });
      }
      return undefined;
    }
    this.noteGoalEvent(sessionId, 'step_skipped', {
      step_id: kind,
      metadata: {
        code: hit.code,
        evidence_id: hit.evidenceId,
        command,
        message: hit.message,
      },
    });
    this.log.info(`skipping ${kind} on ${sessionId}: ${hit.code} (${hit.evidenceId})`);
    return { code: hit.code, evidenceId: hit.evidenceId };
  }

  private recordObservedExecutions(
    sessionId: string,
    view: LoadedView,
    facts: ReturnType<typeof foldGoalFacts>,
  ): void {
    const workspacePath = view.header?.cwd ?? this.workspaceBaselines.get(sessionId)?.workspacePath;
    if (workspacePath === undefined || workspacePath === '') return;
    this.recordObservedExecutionFacts(sessionId, workspacePath, facts);
  }

  private recordObservedExecutionFacts(
    sessionId: string,
    workspacePath: string,
    facts: ReturnType<typeof foldGoalFacts>,
  ): void {
    const baseline = this.workspaceBaselines.get(sessionId);
    const goalId = this.goalStore.get(sessionId)?.goal_id ?? `goal-${sessionId}`;
    for (const tool of facts.tools) {
      if (!tool.ok) continue;
      const key = `${sessionId}:${tool.callId}`;
      if (isMutatingTool(tool.name, tool.command) && !this.observedSuccessfulMutationCalls.has(key)) {
        this.rememberObservedSuccessfulMutationCall(key);
        this.pendingBaselineRefresh.add(sessionId);
        if (!this.recordedMutationCalls.has(key)) {
          this.rememberMutationCall(key);
          this.workspaceGuard.recordMutation(workspacePath, {
            sessionId,
            goalId,
            stepId: tool.callId,
            type: idempotencyKindFor(tool.name, tool.command) ?? tool.name,
            details: tool.command,
          });
        }
      }
      const kind = idempotencyKindFor(tool.name, tool.command);
      if (kind === undefined) continue;
      if (this.recordedExecutionEvidenceCalls.has(key)) continue;
      this.rememberExecutionEvidenceCall(key);
      const pending = this.pendingExecutionFingerprints.get(key);
      this.pendingExecutionFingerprints.delete(key);
      const fingerprint = pending?.kind === kind
        ? pending.fingerprint
        : this.idempotencyManager.computeFingerprint({
            kind,
            command: tool.command,
            workspacePath,
            headSha: baseline?.headSha,
            extra: this.executionFingerprintExtra(baseline),
          });
      if (this.idempotencyManager.check(fingerprint, { sessionId, workspacePath }) !== null) continue;
      this.idempotencyManager.recordSuccess(fingerprint, {
        kind,
        status: isVerifiedKind(kind) ? 'passed' : 'applied',
        summary: tool.resultText,
        sessionId,
        workspacePath,
      });
    }
  }

  private executionFingerprintExtra(snapshot?: WorkspaceBaseline): Record<string, unknown> {
    return {
      workspace_fingerprint: snapshot?.workspaceFingerprint ?? '',
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    };
  }

  private async refreshWorkspaceBaselineIfNeeded(sessionId: string, workspacePath: string): Promise<void> {
    if (!this.pendingBaselineRefresh.delete(sessionId)) return;
    this.workspaceBaselines.set(sessionId, await this.workspaceGuard.captureBaseline(workspacePath));
  }

  private noteMutation(
    workspacePath: string,
    sessionId: string,
    toolName: string,
    command: string | undefined,
    callId?: string,
  ): void {
    const key = `${sessionId}:${callId ?? toolName}:${command ?? ''}`;
    if (this.recordedMutationCalls.has(key)) return;
    this.rememberMutationCall(key);
    this.workspaceGuard.recordMutation(workspacePath, {
      sessionId,
      goalId: this.goalStore.get(sessionId)?.goal_id ?? `goal-${sessionId}`,
      stepId: callId,
      type: idempotencyKindFor(toolName, command) ?? toolName,
      details: command,
    });
  }

  private rememberMutationCall(key: string): void {
    this.recordedMutationCalls.add(key);
    while (this.recordedMutationCalls.size > 2048) {
      const oldest = this.recordedMutationCalls.values().next().value;
      if (oldest === undefined) break;
      this.recordedMutationCalls.delete(oldest);
    }
  }

  private rememberExecutionEvidenceCall(key: string): void {
    rememberCappedSet(this.recordedExecutionEvidenceCalls, key);
  }

  private rememberObservedSuccessfulMutationCall(key: string): void {
    rememberCappedSet(this.observedSuccessfulMutationCalls, key);
  }

  private rememberPendingExecutionFingerprint(
    key: string,
    value: { kind: string; fingerprint: string },
  ): void {
    if (this.pendingExecutionFingerprints.has(key)) this.pendingExecutionFingerprints.delete(key);
    this.pendingExecutionFingerprints.set(key, value);
    while (this.pendingExecutionFingerprints.size > 2048) {
      const oldest = this.pendingExecutionFingerprints.keys().next().value;
      if (oldest === undefined) break;
      this.pendingExecutionFingerprints.delete(oldest);
    }
  }

  // ── introspection used by the MCP layer ───────────────────────────────────

  listManaged(): string[] {
    return [...this.managed];
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((item) => item.trim() !== ''))];
}

function rememberCappedSet(target: Set<string>, value: string, cap = 2048): void {
  if (target.has(value)) target.delete(value);
  target.add(value);
  while (target.size > cap) {
    const oldest = target.values().next().value;
    if (oldest === undefined) break;
    target.delete(oldest);
  }
}

function isMutatingTool(toolName: string, command?: string): boolean {
  const classes = classesForTool(toolName, command);
  return classes.includes('filesystem.write')
    || classes.includes('git.mutate')
    || classes.includes('npm.publish')
    || classes.includes('github.release')
    || classes.includes('external_path.write');
}

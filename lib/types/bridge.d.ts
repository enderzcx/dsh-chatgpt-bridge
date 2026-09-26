import type { Context } from '@deepseek-ai/cordis';
import { type SessionEvent } from '@deepseek-ai/dsh-session';
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        'agent-preset/selected': {
            agentPreset: string;
        };
    }
}
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval';
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions';
import type { Workspace } from '@deepseek-ai/dsh-workspace';
import type { ResolvedBridgeConfig } from './config.js';
import type { BridgeLogger } from './log.js';
import { type Delivery, type PendingMessageView } from './inbox.js';
import { type BridgeStatus } from './status.js';
import { type MessageRow, type ToolCallInfo } from './session-view.js';
import { type ExecutionSupervisionView, type GoalStartResult, type GoalWaitResult } from './goal.js';
import { type BlockedInfo } from './goal-graph.js';
import { type GoalHistoryEvent, type GoalSupervisionView } from './goal-control.js';
import { type ExecutionMode, type GoalConstraints } from './goal-constraints.js';
import { type UserApprovalPolicy } from './approval-policy.js';
import { WorkspaceConcurrencyGuard } from './workspace-guard.js';
import { ExecutionIdempotencyManager } from './execution-idempotency.js';
import { type ResultSchema, type CredentialStatus } from './result-schema.js';
export { normalizePath } from './paths.js';
/** Typed bridge error with a stable machine-readable code. */
export declare class BridgeError extends Error {
    readonly code: string;
    readonly details?: Record<string, unknown>;
    constructor(code: string, message: string, details?: Record<string, unknown>);
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
            header?: {
                cwd?: string;
            };
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
    bridge: {
        name: string;
        version: string;
    };
    dsh: {
        version: string;
    };
    runtime: {
        pid: number;
        uptimeMs: number;
    };
    sessions: {
        live: number;
        persisted: number;
        active: number;
    };
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
    agent?: {
        status: 'idle' | 'running';
        inbox: {
            nextTurn: number;
            nextStep: number;
        };
    };
    pending: {
        nextTurn: number;
        nextStep: number;
    };
    waiting: WaitingState;
    messages: MessageRow[];
    last_turn?: {
        turn: number;
        reason?: string;
    };
    todos?: {
        content: string;
        status: string;
    }[];
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
    queue: {
        nextTurn: number;
        nextStep: number;
    };
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
    previous: {
        message_id: string;
        target: 'next-turn' | 'next-step';
        delivery: Delivery;
        index: number;
        version: string;
    };
    queue: {
        nextTurn: number;
        nextStep: number;
    };
}
export interface ResultView {
    session_id: string;
    status: BridgeStatus;
    turn: number;
    summary: string;
    assistant_text: string;
    changed_files: string[];
    tool_calls: ToolCallInfo[];
    error?: {
        code: string;
        message: string;
    };
    result_schema?: ResultSchema;
}
/** DSH version string, resolved lazily from the installed package. */
export declare function dshVersion(): string;
/** The bridge service. One instance per plugin activation. */
export declare class Bridge {
    private readonly ctx;
    private readonly cfg;
    private readonly log;
    /** Sessions created through this bridge (approval answering scope). */
    private readonly managed;
    private readonly approvals;
    private readonly questions;
    private questionSeq;
    private approvalsEnabled;
    private questionsEnabled;
    private started;
    private readonly goalRequests;
    private readonly goalStore;
    private readonly pollCursors;
    private apiProxy;
    private muxAbort;
    private webOwnsApprovals;
    readonly workspaceGuard: WorkspaceConcurrencyGuard;
    readonly idempotencyManager: ExecutionIdempotencyManager;
    private readonly workspaceBaselines;
    private readonly recordedMutationCalls;
    private readonly recordedExecutionEvidenceCalls;
    private readonly observedSuccessfulMutationCalls;
    private readonly pendingBaselineRefresh;
    private readonly pendingExecutionFingerprints;
    approvalPolicy: UserApprovalPolicy;
    /** Test hooks for bounded wait loops. */
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    constructor(ctx: Context, cfg: ResolvedBridgeConfig, log: BridgeLogger);
    /** Register the approval answerer and the user-questions provider. */
    start(): void;
    private adopt;
    /** Count of bridge-created sessions still live. */
    managedCount(): number;
    private agentOptions;
    /** Agent-scoped model selection with log-derived fallback for resumes. */
    private installSelection;
    /** Compose the preset+selection setup used at agent creation/resume. */
    private composeSetupFor;
    private loadView;
    /** Resolve a live agent, resuming the persisted session when needed. */
    private ensureAgent;
    listWorkspaces(): Promise<WorkspaceView[]>;
    /**
     * Resolve a workspace reference (id, canonical path, or title) against the
     * REGISTERED workspace set only. Never auto-registers and never opens an
     * arbitrary path: an unregistered path is rejected.
     */
    resolveWorkspace(input: string): Promise<Workspace>;
    health(): Promise<HealthReport>;
    createSession(workspaceInput: string, title?: string, initialMessage?: string): Promise<SessionView>;
    sendMessage(sessionId: string, message: string): Promise<{
        session_id: string;
        accepted: boolean;
    }>;
    /**
     * Deliver one message to the live agent's inbox.
     * @param sessionId - the session that owns the agent.
     * @param message - the text to deliver; must not be blank.
     * @param delivery - `followup` queues its own turn (DSH's default), `steer`
     *   is consumed at the nearest step boundary.
     * @returns the accepted identity and the destination it actually reached.
     */
    deliverMessage(sessionId: string, message: string, delivery?: Delivery): Promise<DeliveryResult>;
    /** Whether the transcript gained this identity after {@link fromIndex}. */
    private wasAdmittedSince;
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
    listPendingMessages(sessionId: string, maxChars?: number): Promise<{
        session_id: string;
        live: boolean;
        agent_status?: 'idle' | 'running';
        next_step: PendingMessageView[];
        next_turn: PendingMessageView[];
        total: number;
    }>;
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
    promotePendingMessage(sessionId: string, messageId: string, expectedVersion?: string): Promise<MessageMutationResult>;
    /**
     * Replace the text of one pending message, preserving its identity.
     * @param sessionId - the session that owns the agent.
     * @param messageId - identity of the pending message.
     * @param message - the replacement text.
     * @param expectedVersion - optional digest from a prior read; a mismatch refuses the edit.
     * @returns the message's position after the edit.
     */
    editPendingMessage(sessionId: string, messageId: string, message: string, expectedVersion?: string): Promise<MessageMutationResult>;
    /**
     * Remove one pending message from the queue.
     * @param sessionId - the session that owns the agent.
     * @param messageId - identity of the pending message.
     * @param expectedVersion - optional digest from a prior read; a mismatch refuses the withdrawal.
     * @returns the position the message occupied before removal.
     */
    withdrawPendingMessage(sessionId: string, messageId: string, expectedVersion?: string): Promise<MessageMutationResult>;
    /** Whether the agent exposes the native steering capability and a live inbox. */
    private static nativeSteerCapable;
    /**
     * Put an undelivered message back at its recorded position.
     *
     * Only ever called after DSH was confirmed not to hold and not to have
     * admitted the identity, so this cannot create a second copy. The identity is
     * unique across both native lists, which the inbox enforces.
     * @returns whether the restore was applied and verified.
     */
    private restorePending;
    /** The visible text of one pending message, for diagnostics only. */
    private static inboxText;
    /** Read the live agent's inbox, or explain why this session cannot be queued into. */
    private requireInbox;
    /** Report the current native pending sizes. */
    private queueState;
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
    private mutatePending;
    /**
     * Refuse a mutation that would contradict the supervised-Goal record.
     *
     * Goal control envelopes are the durable statement of the Goal, and the
     * bridge reconciles them against the transcript. Editing, withdrawing or
     * re-steering one behind the record's back — or pushing a superseded revision
     * back into the current turn — is exactly the contradiction the Goal
     * supervision path exists to prevent.
     */
    private refuseProtectedGoalMessage;
    /**
     * Explain an identity that is no longer pending, using the durable log.
     *
     * The three refusals are deliberately distinct, because the caller's right
     * next move differs: an admitted message is already in the transcript, a
     * formerly-pending one was withdrawn or discarded, and an unrecognized one
     * belongs to a different session or never existed.
     */
    private staleMessageError;
    /** Whether DSH already appended this identity to the durable transcript. */
    private wasAdmitted;
    /** Read a live agent's own durable event log. */
    private eventsOf;
    cancelTask(sessionId: string): Promise<{
        session_id: string;
        cancelled: boolean;
    }>;
    private waitingFor;
    private statusOf;
    private titleOf;
    private viewOf;
    getSession(sessionId: string, maxItems?: number, maxChars?: number): Promise<SessionView>;
    listSessions(options: {
        limit?: number;
        offset?: number;
        workspace?: string;
    }): Promise<SessionSummary[]>;
    /** Zero-I/O cached title for a cold session, when a projection cache is mounted. */
    private cachedTitle;
    getResult(sessionId: string, maxChars?: number): Promise<ResultView>;
    getTaskStatus(sessionId: string): Promise<{
        session_id: string;
        status: BridgeStatus;
        live: boolean;
        agent_status?: 'idle' | 'running';
        pending: {
            nextTurn: number;
            nextStep: number;
        };
        waiting: WaitingState;
        last_turn?: {
            turn: number;
            reason?: string;
        };
        updated_at?: string;
        todos?: {
            content: string;
            status: string;
        }[];
        blocked?: BlockedInfo;
        deferred_steps?: string[];
        blocked_steps?: string[];
        remaining_runnable_steps?: string[];
        goal?: GoalSupervisionView;
        execution?: ExecutionSupervisionView;
        history?: GoalHistoryEvent[];
    }>;
    createGoal(input: {
        workspace: string;
        goal: string;
        plan?: string;
        execution_mode?: ExecutionMode;
        constraints?: GoalConstraints;
        request_id?: string;
        workspace_lock_override?: boolean;
    }): Promise<GoalStartResult>;
    reviseGoal(input: {
        session_id: string;
        goal?: string;
        plan?: string;
        execution_mode?: ExecutionMode;
        constraints?: GoalConstraints;
        expected_revision?: number;
        revision_reason?: string;
        request_id?: string;
        workspace_lock_override?: boolean;
    }): Promise<GoalStartResult>;
    pauseGoal(sessionId: string): Promise<{
        session_id: string;
        status: BridgeStatus;
        paused: boolean;
        checkpoint_revision: number;
    }>;
    resumeGoal(sessionId: string, resumeSteps?: string[], requestId?: string, workspaceLockOverride?: boolean): Promise<GoalStartResult>;
    retryStep(sessionId: string, stepId: string, requestId?: string, workspaceLockOverride?: boolean): Promise<GoalStartResult>;
    rerunStep(sessionId: string, stepId: string, requestId?: string, workspaceLockOverride?: boolean): Promise<GoalStartResult>;
    waitUntilActionRequired(sessionId: string, waitSeconds?: number): Promise<GoalWaitResult>;
    getStructuredResult(sessionId: string): Promise<ResultSchema>;
    getCredentialStatus(): CredentialStatus[];
    startGoal(input: {
        workspace: string;
        goal: string;
        plan?: string;
        session_id?: string;
        request_id?: string;
        execution_mode?: ExecutionMode;
        constraints?: GoalConstraints;
        expected_revision?: number;
        workspace_lock_override?: boolean;
    }): Promise<GoalStartResult>;
    updateGoal(input: {
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
    }): Promise<GoalStartResult>;
    waitGoal(sessionId: string, waitSeconds?: number): Promise<GoalWaitResult>;
    stopGoal(sessionId: string): Promise<{
        session_id: string;
        stopped: true;
        already_stopped: boolean;
        status: BridgeStatus;
        cleanup_warning?: string;
    }>;
    private failClosedWaiting;
    private applyStartOrRevise;
    private controlMessage;
    private mapGoalStart;
    private noteGoalEvent;
    /**
     * Decide a DSH approval/request for a managed session.
     * Idempotent high-cost steps are skipped; L0/L1 may auto-approve;
     * deny/reject always remain reachable even if approve is blocked.
     */
    decideApproval(request: ApprovalRequestLike, next?: () => Promise<ApprovalOutcome> | ApprovalOutcome): Promise<ApprovalOutcome>;
    private rejectConstraint;
    private observeGoal;
    private goalFields;
    private cleanupGoalTemps;
    private goalSnapshot;
    answerQuestion(questionId: string, sessionId: string | undefined, answer: {
        selected: string[];
        custom?: string;
    }): Promise<{
        answered: true;
    }>;
    approve(sessionId: string, approvalId: string, decision: 'approve' | 'reject'): Promise<{
        approval_id: string;
        session_id: string;
        decision: 'approve' | 'reject';
        outcome: ApprovalOutcome;
        layer: ApprovalLayer;
        fail_closed?: boolean;
    }>;
    private isLockHolderActive;
    private workspaceLockedError;
    private assertMutableWorkspaceAvailable;
    private takeWorkspaceLock;
    private releaseWorkspaceIfTerminal;
    private skipIdempotentStep;
    private recordObservedExecutions;
    private recordObservedExecutionFacts;
    private executionFingerprintExtra;
    private refreshWorkspaceBaselineIfNeeded;
    private noteMutation;
    private rememberMutationCall;
    private rememberExecutionEvidenceCall;
    private rememberObservedSuccessfulMutationCall;
    private rememberPendingExecutionFingerprint;
    listManaged(): string[];
}

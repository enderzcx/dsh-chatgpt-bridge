import type { Agent, InboxTarget } from '@deepseek-ai/dsh-agent';
import { type UserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
/** How one delivery reaches the agent. `followup` is DSH's own default. */
export type Delivery = 'followup' | 'steer';
/** Map the bridge's delivery vocabulary onto DSH's inbox destination. */
export declare function targetFor(delivery: Delivery): InboxTarget;
/** Bridge-side name for one pending message's position. */
export interface PendingPosition {
    message_id: string;
    target: InboxTarget;
    delivery: Delivery;
    index: number;
    /** Content digest of the pending message at read time. */
    version: string;
}
/** One pending message, with the stable identity a caller acts on. */
export interface PendingMessageView extends PendingPosition {
    chars: number;
    text: string;
    truncated: boolean;
    /** Whether the message carries anything the bridge cannot faithfully re-send. */
    non_text: boolean;
    /** Set when this is a supervised-Goal control envelope (protected). */
    goal_message?: {
        goal_id?: string;
        revision?: number;
        stale: boolean;
    };
}
/** The two pending lists, read from either a live agent or the durable log. */
export interface InboxSnapshot {
    status?: 'idle' | 'running';
    nextStep: readonly UserMessage[];
    nextTurn: readonly UserMessage[];
}
/**
 * Content digest of one pending message.
 *
 * Covers the identity, the exact content blocks, and the source, so an edit made
 * elsewhere is always visible as a version change. Only a digest is exposed;
 * the content itself is already returned as bounded text.
 */
export declare function messageVersion(message: UserMessage): string;
/** Whether one message holds any block the bridge cannot reproduce verbatim. */
export declare function hasNonTextBlocks(message: UserMessage): boolean;
/**
 * Recognise a supervised-Goal control envelope.
 *
 * Goal messages are stated in durable text and reconciled against the
 * transcript, so a hand-edited copy would contradict the stored record.
 * @param message - the pending message to inspect.
 * @param currentRevision - the Goal revision the bridge currently holds.
 * @returns the Goal identity and whether this copy is behind the record.
 */
export declare function goalMessageOf(message: UserMessage, currentRevision: number | undefined): {
    goal_id?: string;
    revision?: number;
    stale: boolean;
} | undefined;
/** Build the bounded wire view of one pending message. */
export declare function pendingView(message: UserMessage, target: InboxTarget, index: number, maxChars: number, currentGoalRevision?: number): PendingMessageView;
/** Read both pending lists from a live agent. */
export declare function liveSnapshot(agent: Agent): InboxSnapshot;
/**
 * Read both pending lists from a durable log without waking an agent.
 * @param events - the session event log, live or persisted.
 * @returns the pending lists as the log's own splices describe them.
 */
export declare function durableSnapshot(events: readonly SessionEvent[]): InboxSnapshot;
/**
 * Locate one pending message by identity across both native lists.
 * @param snapshot - the pending lists to search.
 * @param messageId - the identity a caller supplied.
 * @returns the position, or `undefined` when the identity is not pending.
 */
export declare function locatePending(snapshot: InboxSnapshot, messageId: string): {
    message: UserMessage;
    target: InboxTarget;
    index: number;
} | undefined;
/**
 * Freeze one pending message with new text, preserving its identity and source.
 *
 * DSH's `replace` matches on identity, so an edit must keep `id`; `freezeMessage`
 * is DSH's own deep-freeze so the replacement is as immutable as the original.
 * Callers must reject non-text content first — this refuses rather than dropping
 * any block it cannot reproduce.
 * @param existing - the message being replaced.
 * @param text - the replacement text.
 * @returns a frozen user message that carries the original identity.
 */
export declare function replaceText(existing: UserMessage, text: string): UserMessage;
/** Narrow an inbox mutation result into the bridge's stable position answer. */
export declare function positionResult(message: UserMessage, target: InboxTarget, index: number): PendingPosition;

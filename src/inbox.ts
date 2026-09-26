/**
 * Pending-input (inbox) reading and queue management over DSH's native Agent
 * inbox. DSH's agent loop owns the two durable pending lists and already
 * exposes every mutation the bridge needs; this module only names them, so the
 * bridge never keeps a second queue of its own.
 *
 * Native contract (`@deepseek-ai/dsh-agent` `Inbox` / `ReactLoopAgent`, and the
 * DSH session controller's own queue commands):
 *   - `next-turn` prompts each become the sole ordinary message of their own turn
 *   - `next-step` input is consumed at the nearest step boundary
 *   - `followup(m)` → `send(m, 'next-turn', true)`; `steer(m)` →
 *     `send(m, 'next-step', true)`; `send(m, target, wake)` is the primitive
 *   - `replace(id, m)` / `remove(id)` / `splice(target, start, count, inserted)`
 *     mutate in place and report whether the identity was still pending
 *   - queue **edits accept text content only**, and the text must not be blank
 *   - promoting a `next-turn` item to steering requires the item to still be in
 *     `next-turn` and the agent to be `running`; the operation is
 *     `remove(id)` then `steer(sameMessage)`
 *   - identities are unique across both lists; a duplicate is a hard error
 *
 * "Accepted" here means the message entered a pending list. A turn or step
 * boundary *claims* the list and appends the claimed messages to the durable
 * session log, which is the strongest fact the log supports. Nothing at this
 * layer observes whether a model read or understood the text.
 */
import { createHash } from 'node:crypto';
import type { Agent, InboxTarget } from '@deepseek-ai/dsh-agent';
import { freezeMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { redactText } from './redact.js';

/** How one delivery reaches the agent. `followup` is DSH's own default. */
export type Delivery = 'followup' | 'steer';

/** Map the bridge's delivery vocabulary onto DSH's inbox destination. */
export function targetFor(delivery: Delivery): InboxTarget {
  return delivery === 'steer' ? 'next-step' : 'next-turn';
}

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
  goal_message?: { goal_id?: string; revision?: number; stale: boolean };
}

/** The two pending lists, read from either a live agent or the durable log. */
export interface InboxSnapshot {
  status?: 'idle' | 'running';
  nextStep: readonly UserMessage[];
  nextTurn: readonly UserMessage[];
}

const GOAL_BANNER = /^\[Goal\] rev (\d+) · /;

/**
 * Content digest of one pending message.
 *
 * Covers the identity, the exact content blocks, and the source, so an edit made
 * elsewhere is always visible as a version change. Only a digest is exposed;
 * the content itself is already returned as bounded text.
 */
export function messageVersion(message: UserMessage): string {
  const source = message.source as { kind?: unknown; plugin?: unknown; rpcId?: unknown };
  const material = JSON.stringify({
    id: String(message.id),
    role: message.role,
    content: message.content,
    source: { kind: source.kind ?? null, plugin: source.plugin ?? null, rpcId: source.rpcId ?? null },
  });
  return createHash('sha256').update(material).digest('hex');
}

/** Concatenate the visible text of one message's own text blocks. */
function messageText(message: UserMessage): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text') parts.push((block as { text: string }).text);
  }
  return parts.join('\n');
}

/** Whether one message holds any block the bridge cannot reproduce verbatim. */
export function hasNonTextBlocks(message: UserMessage): boolean {
  return message.content.some((block) => block.type !== 'text');
}

/**
 * Recognise a supervised-Goal control envelope.
 *
 * Goal messages are stated in durable text and reconciled against the
 * transcript, so a hand-edited copy would contradict the stored record.
 * @param message - the pending message to inspect.
 * @param currentRevision - the Goal revision the bridge currently holds.
 * @returns the Goal identity and whether this copy is behind the record.
 */
export function goalMessageOf(
  message: UserMessage,
  currentRevision: number | undefined,
): { goal_id?: string; revision?: number; stale: boolean } | undefined {
  const match = GOAL_BANNER.exec(messageText(message));
  if (match === null) return undefined;
  const revision = Number(match[1]);
  const identity = /goal_id=(\S+?)\s+revision=(\d+)/.exec(messageText(message));
  return {
    ...(identity === null ? {} : { goal_id: identity[1] }),
    revision: Number.isNaN(revision) ? undefined : revision,
    stale: currentRevision !== undefined && !Number.isNaN(revision) && revision < currentRevision,
  };
}

/** Build the bounded wire view of one pending message. */
export function pendingView(
  message: UserMessage,
  target: InboxTarget,
  index: number,
  maxChars: number,
  currentGoalRevision?: number,
): PendingMessageView {
  const claimed = messageText(message);
  const safe = redactText(claimed);
  const limit = Math.max(1, maxChars);
  const goal = goalMessageOf(message, currentGoalRevision);
  return {
    message_id: String(message.id),
    target,
    delivery: target === 'next-step' ? 'steer' : 'followup',
    index,
    version: messageVersion(message),
    chars: safe.length,
    text: safe.length > limit ? `${safe.slice(0, limit)}…` : safe,
    truncated: safe.length > limit,
    non_text: hasNonTextBlocks(message),
    ...(goal === undefined ? {} : { goal_message: goal }),
  };
}

/** Read both pending lists from a live agent. */
export function liveSnapshot(agent: Agent): InboxSnapshot {
  return { status: agent.status, nextStep: agent.inbox.nextStep, nextTurn: agent.inbox.nextTurn };
}

/** Collect the pending lists a durable log still holds. */
function foldInboxEvents(events: readonly SessionEvent[]): { 'next-turn': UserMessage[]; 'next-step': UserMessage[] } {
  const lists: { 'next-turn': UserMessage[]; 'next-step': UserMessage[] } = { 'next-turn': [], 'next-step': [] };
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue;
    const splice = event.data as {
      target?: InboxTarget;
      start?: number;
      removedCount?: number;
      inserted?: readonly UserMessage[];
    };
    if (splice.target !== 'next-turn' && splice.target !== 'next-step') continue;
    const list = lists[splice.target];
    const start = Math.max(0, Math.min(Math.trunc(splice.start ?? list.length), list.length));
    const removed = splice.removedCount === undefined
      ? list.length - start
      : Math.max(0, Math.min(Math.trunc(splice.removedCount), list.length - start));
    list.splice(start, removed, ...(splice.inserted ?? []));
  }
  return lists;
}

/**
 * Read both pending lists from a durable log without waking an agent.
 * @param events - the session event log, live or persisted.
 * @returns the pending lists as the log's own splices describe them.
 */
export function durableSnapshot(events: readonly SessionEvent[]): InboxSnapshot {
  const lists = foldInboxEvents(events);
  return { nextStep: lists['next-step'], nextTurn: lists['next-turn'] };
}

/**
 * Locate one pending message by identity across both native lists.
 * @param snapshot - the pending lists to search.
 * @param messageId - the identity a caller supplied.
 * @returns the position, or `undefined` when the identity is not pending.
 */
export function locatePending(
  snapshot: InboxSnapshot,
  messageId: string,
): { message: UserMessage; target: InboxTarget; index: number } | undefined {
  const wanted = String(messageId);
  const search: [InboxTarget, readonly UserMessage[]][] = [
    ['next-turn', snapshot.nextTurn],
    ['next-step', snapshot.nextStep],
  ];
  for (const [target, list] of search) {
    const index = list.findIndex((message) => String(message.id) === wanted);
    if (index >= 0) return { message: list[index], target, index };
  }
  return undefined;
}

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
export function replaceText(existing: UserMessage, text: string): UserMessage {
  if (hasNonTextBlocks(existing)) {
    throw new Error('replaceText refuses a message with non-text blocks; reject the edit instead');
  }
  return freezeMessage({ ...existing, content: [{ type: 'text' as const, text }] });
}

/** Narrow an inbox mutation result into the bridge's stable position answer. */
export function positionResult(
  message: UserMessage,
  target: InboxTarget,
  index: number,
): PendingPosition {
  return {
    message_id: String(message.id),
    target,
    delivery: target === 'next-step' ? 'steer' : 'followup',
    index,
    version: messageVersion(message),
  };
}

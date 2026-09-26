/**
 * Shared harness for pending-input (steering / queue) tests.
 *
 * Two levels of fidelity are available on purpose:
 *
 *  1. `makeNativeInbox` wraps the REAL `ReactLoopInbox` from
 *     `@deepseek-ai/dsh-agent-loop` in a minimal session whose `append`
 *     records durable splices and folds the projection exactly as DSH does.
 *     The code under test is therefore DSH's own queue, not a stand-in.
 *
 *  2. `makeQueueAgent` presents that inbox through the public `Agent` shape
 *     the bridge consumes, so bridge-level ordering can be asserted without a
 *     model, a driver, or a profile.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

/**
 * Load DSH's REAL `ReactLoopInbox` implementation.
 *
 * `@deepseek-ai/dsh-agent-loop` bundles the inbox but does not re-export the
 * class (only `AgentLoop` and settings are public). Rather than re-implement
 * the queue — which would prove nothing — this loads the class from the
 * package's own `//#region lib/types/inbox.js` bundle region and evaluates it
 * against the real `zod` the bundle expects. The running code is verbatim DSH.
 */
let reactLoopInboxClass;
function realReactLoopInbox() {
  if (reactLoopInboxClass !== undefined) return reactLoopInboxClass;
  const require = createRequire(import.meta.url);
  const entry = require.resolve('@deepseek-ai/dsh-agent-loop');
  const source = readFileSync(entry, 'utf8');
  const start = source.indexOf('//#region lib/types/inbox.js');
  // The closing marker is bare in the shipped bundle; accept either spelling.
  const namedEnd = source.indexOf('//#endregion lib/types/inbox.js');
  const end = namedEnd >= 0 ? namedEnd : source.indexOf('//#endregion', start);
  if (start < 0 || end < 0) {
    throw new Error('dsh-agent-loop bundle no longer exposes the inbox region; re-check the native API contract');
  }
  const region = source.slice(start, end).replace(/\/\/# sourceMappingURL=.*$/m, '');
  const module = { exports: {} };
  vm.runInNewContext(
    `${region}\nmodule.exports.ReactLoopInbox = ReactLoopInbox;`,
    { module, exports: module.exports, z: require('zod'), z$1: require('zod') },
    { filename: 'dsh-agent-loop/lib/types/inbox.js' },
  );
  reactLoopInboxClass = module.exports.ReactLoopInbox;
  return reactLoopInboxClass;
}

/**
 * Build a minimal session whose `append` both records the event and folds the
 * inbox projection, so `nextTurn` / `nextStep` observe exactly what DSH's
 * durable log would report.
 */
export function makeNativeInbox() {
  const events = [];
  const state = { 'next-turn': [], 'next-step': [] };

  /** Fold one durable inbox splice the way DSH's projection does. */
  function applySplice(splice) {
    const list = state[splice.target];
    const removed = splice.removedCount ?? 0;
    const next = list.toSpliced(splice.start, removed, ...splice.inserted);
    const seen = new Set();
    for (const message of splice.target === 'next-turn' ? [...next, ...state['next-step']] : [...state['next-turn'], ...next]) {
      if (seen.has(message.id)) throw new Error(`message "${message.id}" is already pending`);
      seen.add(message.id);
    }
    state[splice.target] = next;
  }

  const session = {
    id: 'session-native',
    append(type, data) {
      const event = { type, seq: events.length, time: Date.now(), data };
      events.push(event);
      if (type === 'agent/inbox/spliced') applySplice(data);
      return event;
    },
    snapshotEvents: () => events,
  };

  // The pinned 0.1.5 inbox registers its projection definition in its own
  // constructor; `stateOf(key)` then returns the folded state.
  const registered = new Set();
  const projections = {
    register: (definition) => registered.add(definition.key),
    stateOf: (_session, key) => (key === 'inbox' && registered.has('inbox') ? state : undefined),
  };

  const dispatched = [];
  const dispatch = { emit: (type, payload) => dispatched.push({ type, payload }) };

  const inbox = new (realReactLoopInbox())(projections, session, dispatch);
  return { inbox, session, events, state, dispatched };
}

/** One user message with the given text, carrying a fresh stable identity. */
export function userMessage(text) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
}

/** The visible text of one message, for assertions. */
export function textOf(message) {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Expose a native inbox through the public `Agent` surface the bridge uses.
 * The delivery methods delegate to DSH's own inbox, so `send('next-step')` and
 * `steer()` take exactly the same path they take in the live loop.
 * @param options.status - reported agent status, `running` by default.
 */
export function makeQueueAgent({ status = 'running' } = {}) {
  const native = makeNativeInbox();
  const agent = {
    id: 'session-queue',
    status,
    inbox: native.inbox,
    session: native.session,
    /** How many times DSH's delivery primitive was used, and where to. */
    sendCount: 0,
    steerCount: 0,
    wakes: 0,
    /** DSH's one delivery primitive. */
    send(message, target, wakeup) {
      agent.sendCount += 1;
      if (target === 'next-step') agent.steerCount += 1;
      const resolved = status !== 'idle' && agent.aborted && target === 'next-step' ? 'next-turn' : target;
      native.inbox.splice(resolved, Number.POSITIVE_INFINITY, 0, [message]);
      if (wakeup) agent.wakes += 1;
    },
    followup(message) {
      agent.send(message, 'next-turn', true);
    },
    steer(message) {
      agent.send(message, 'next-step', true);
    },
    inject(message) {
      agent.send(message, 'next-step', false);
    },
    cancel() {
      native.inbox.clear();
    },
    native,
  };
  return agent;
}

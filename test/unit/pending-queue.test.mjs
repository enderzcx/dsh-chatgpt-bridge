/**
 * Queue management over DSH's native Agent inbox, driven through the bridge.
 *
 * The agent under test is the shared queue harness: its inbox is the REAL
 * `ReactLoopInbox` (see test/helpers/queue-harness.mjs), so ordering and
 * identity assertions describe DSH's own queue rather than a test double.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bridge, BridgeError } from '../../lib/bridge.js';
import { makeQueueAgent, textOf, userMessage } from '../helpers/queue-harness.mjs';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

const WORKSPACE = 'D:\\Agent\\agent_workplace\\mix_workspace';

/** One bridge whose only live session is the queue agent under test. */
function makeBridgeWith(agent) {
  const services = {
    workspaceRegistry: { list: () => [] },
    agents: { get: (id) => (id === agent.id ? agent : undefined), list: () => [agent] },
    sessions: { list: () => [], get: () => undefined },
    sessionPersistence: { list: async () => [] },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  };
  const ctx = {
    get: (key) => services[key],
    agents: services.agents,
    sessions: services.sessions,
    sessionPersistence: services.sessionPersistence,
    agentDefaultModel: services.agentDefaultModel,
    sessionTitle: undefined,
    on: () => {},
  };
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  return new Bridge(ctx, { sessionMaxItems: 5, sessionMaxChars: 200, resultMaxItems: 10, resultMaxChars: 500 }, log);
}

/** A live queue agent whose session header reports one workspace. */
function makeAgent(options) {
  const agent = makeQueueAgent(options);
  agent.session.header = { id: agent.id, createdAt: Date.now(), cwd: WORKSPACE };
  return agent;
}

function expectCode(code) {
  return (error) => {
    assert.ok(error instanceof BridgeError, `expected BridgeError, received ${error}`);
    assert.equal(error.code, code);
    return true;
  };
}

test('delivery: followup is the default and lands in next-turn', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);

  const result = await bridge.deliverMessage('session-queue', 'ordinary message');

  assert.equal(result.target, 'next-turn');
  assert.equal(result.delivery, 'followup');
  assert.equal(result.state, 'queued');
  assert.equal(result.session_id, 'session-queue');
  assert.match(result.message_id, /^[0-9a-f-]{36}$/);
  assert.equal(agent.inbox.nextTurn.length, 1);
  assert.equal(agent.inbox.nextStep.length, 0);
  assert.equal(textOf(agent.inbox.nextTurn[0]), 'ordinary message');
  assert.deepEqual(result.queue, { nextTurn: 1, nextStep: 0 });
});

test('delivery: an explicit followup behaves identically to the default', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);

  const result = await bridge.deliverMessage('session-queue', 'explicit followup', 'followup');

  assert.equal(result.target, 'next-turn');
  assert.equal(result.delivery, 'followup');
});

test('delivery: steer lands in next-step and is not yet a transcript message', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);

  const result = await bridge.deliverMessage('session-queue', 'redirect now', 'steer');

  assert.equal(result.target, 'next-step');
  assert.equal(result.delivery, 'steer');
  assert.equal(result.state, 'queued');
  assert.equal(agent.inbox.nextStep.length, 1);
  assert.equal(agent.inbox.nextTurn.length, 0);
  // "queued" is the honest word: nothing reached the durable transcript yet.
  assert.equal(agent.native.events.filter((event) => event.type === 'user/message').length, 0);
});

test('delivery: the returned message_id is the identity DSH will claim', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);

  const result = await bridge.deliverMessage('session-queue', 'identify me', 'steer');

  assert.equal(String(agent.inbox.nextStep[0].id), result.message_id);
  const claimed = agent.inbox.claim('next-step', 1);
  assert.equal(String(claimed[0].id), result.message_id);
});

test('delivery: a running agent keeps steer ahead of queued turns', async () => {
  const agent = makeAgent({ status: 'running' });
  const bridge = makeBridgeWith(agent);

  await bridge.deliverMessage('session-queue', 'own turn', 'followup');
  await bridge.deliverMessage('session-queue', 'steer in', 'steer');

  // A step boundary consumes the steering first and leaves the turn queued.
  const steered = agent.inbox.claim('next-step', 1);
  assert.equal(textOf(steered[0]), 'steer in');
  assert.equal(agent.inbox.nextTurn.length, 1);
  assert.equal(textOf(agent.inbox.nextTurn[0]), 'own turn');
});

test('delivery: unsupported delivery is refused without touching the queue', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);

  await assert.rejects(
    () => bridge.deliverMessage('session-queue', 'hello', 'inject'),
    expectCode('DELIVERY_UNSUPPORTED'),
  );
  assert.equal(agent.inbox.hasPending, false);
});

test('delivery: empty text is refused', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);

  await assert.rejects(() => bridge.deliverMessage('session-queue', '   '), expectCode('EMPTY_MESSAGE'));
  assert.equal(agent.inbox.hasPending, false);
});

test('listing: pending messages carry ids, order and delivery, step list first', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);

  const first = await bridge.deliverMessage('session-queue', 'turn one', 'followup');
  const second = await bridge.deliverMessage('session-queue', 'turn two', 'followup');
  const steered = await bridge.deliverMessage('session-queue', 'step one', 'steer');

  const listed = await bridge.listPendingMessages('session-queue');

  assert.equal(listed.total, 3);
  assert.equal(listed.agent_status, 'running');
  // Claim order: next-step is consumed before the queued turns.
  assert.equal(listed.next_step.length, 1);
  assert.equal(listed.next_step[0].message_id, steered.message_id);
  assert.equal(listed.next_step[0].target, 'next-step');
  assert.equal(listed.next_step[0].delivery, 'steer');
  assert.equal(listed.next_step[0].text, 'step one');
  assert.equal(listed.next_step[0].index, 0);
  // next-turn keeps FIFO order.
  assert.equal(listed.next_turn.map((row) => row.message_id).join(','), [first.message_id, second.message_id].join(','));
  assert.equal(listed.next_turn.map((row) => row.text).join(','), 'turn one,turn two');
  assert.equal(listed.next_turn.map((row) => row.delivery).join(','), 'followup,followup');
});

test('listing: text is bounded and marked when truncated', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  await bridge.deliverMessage('session-queue', 'x'.repeat(120), 'followup');

  const listed = await bridge.listPendingMessages('session-queue', 40);

  assert.equal(listed.next_turn[0].chars, 120);
  assert.equal(listed.next_turn[0].truncated, true);
  assert.equal(listed.next_turn[0].text.length, 41);
});

test('listing: an empty inbox reports zeroes rather than failing', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);

  const listed = await bridge.listPendingMessages('session-queue');

  assert.equal(listed.total, 0);
  assert.equal(listed.next_step.length, 0);
  assert.equal(listed.next_turn.length, 0);
});

test('steer: a queued followup becomes steering without duplication', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  const queued = await bridge.deliverMessage('session-queue', 'was a followup', 'followup');
  const original = agent.inbox.nextTurn[0];

  const result = await bridge.promotePendingMessage('session-queue', queued.message_id);

  // DSH's own queue action name, not a hand-rolled splice.
  assert.equal(result.action, 'steer');
  assert.equal(result.target, 'next-step');
  assert.equal(result.delivery, 'steer');
  assert.equal(result.message_id, queued.message_id);
  assert.equal(result.previous.target, 'next-turn');
  // Moved, not copied: exactly one pending copy of the identity survives.
  assert.equal(agent.inbox.nextTurn.length, 0);
  assert.equal(agent.inbox.nextStep.length, 1);
  assert.equal(agent.inbox.nextStep[0], original);
  assert.equal(result.queue.nextTurn + result.queue.nextStep, 1);
});

test('steer: repeated promotions keep their order instead of reversing it', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  const a = await bridge.deliverMessage('session-queue', 'A', 'followup');
  const b = await bridge.deliverMessage('session-queue', 'B', 'followup');
  const c = await bridge.deliverMessage('session-queue', 'C', 'followup');

  // Promote in queue order. `agent.steer` appends, so the promoted messages
  // must come out in the order the caller promoted them.
  await bridge.promotePendingMessage('session-queue', a.message_id);
  await bridge.promotePendingMessage('session-queue', b.message_id);
  await bridge.promotePendingMessage('session-queue', c.message_id);

  assert.equal(agent.inbox.nextTurn.length, 0);
  assert.equal(agent.inbox.nextStep.map(textOf).join('|'), 'A|B|C');
});

test('steer: a message already in next-step is refused, not reordered', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  const steered = await bridge.deliverMessage('session-queue', 'already steering', 'steer');

  await assert.rejects(
    () => bridge.promotePendingMessage('session-queue', steered.message_id),
    expectCode('MESSAGE_NOT_PROMOTABLE'),
  );
  assert.equal(agent.inbox.nextStep.length, 1);
  assert.equal(textOf(agent.inbox.nextStep[0]), 'already steering');
});

test('steer: an idle agent is refused, matching DSH own queue rule', async () => {
  const agent = makeAgent({ status: 'idle' });
  const bridge = makeBridgeWith(agent);
  const queued = await bridge.deliverMessage('session-queue', 'promote me', 'followup');

  await assert.rejects(
    () => bridge.promotePendingMessage('session-queue', queued.message_id),
    expectCode('STEER_UNAVAILABLE'),
  );
  // The message was NOT removed and NOT re-delivered: the guard runs before
  // any mutation, so the only splice in the log is the original delivery.
  assert.equal(agent.inbox.nextTurn.length, 1);
  assert.equal(textOf(agent.inbox.nextTurn[0]), 'promote me');
  assert.equal(agent.native.events.filter((event) => event.type === 'agent/inbox/spliced').length, 1);
});

test('steer: the agent is never woken into a new turn while idle', async () => {
  const agent = makeAgent({ status: 'idle' });
  const bridge = makeBridgeWith(agent);
  const queued = await bridge.deliverMessage('session-queue', 'promote me', 'followup');
  const sendsBefore = agent.sendCount;

  await assert.rejects(() => bridge.promotePendingMessage('session-queue', queued.message_id));

  // deliverMessage used one send; the refused promotion must add none.
  assert.equal(agent.sendCount, sendsBefore);
  assert.equal(agent.inbox.hasPending, true);
});

test('steer: a concurrent claim is reported and the message is not re-delivered', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  const queued = await bridge.deliverMessage('session-queue', 'race me', 'followup');

  // The boundary claims and admits the message between the read and the remove.
  const realRemove = agent.inbox.remove.bind(agent.inbox);
  agent.inbox.remove = (id) => {
    for (const claimed of agent.inbox.claim('next-turn', 1)) {
      agent.session.append('user/message', claimed);
    }
    return realRemove(id);
  };

  await assert.rejects(
    () => bridge.promotePendingMessage('session-queue', queued.message_id),
    expectCode('MESSAGE_ALREADY_ADMITTED'),
  );
  assert.equal(agent.inbox.hasPending, false);
  assert.equal(agent.native.events.filter((event) => event.type === 'user/message').length, 1);
});

test('steer: the promoted message is what the next step boundary claims', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  await bridge.deliverMessage('session-queue', 'stays a turn', 'followup');
  const promoted = await bridge.deliverMessage('session-queue', 'steer this', 'followup');

  const result = await bridge.promotePendingMessage('session-queue', promoted.message_id);
  const claimed = agent.inbox.claim('next-step', 5);

  assert.equal(claimed.length, 1);
  assert.equal(String(claimed[0].id), promoted.message_id);
  assert.equal(textOf(claimed[0]), 'steer this');
  assert.equal(result.index, 0);
  // The untouched turn is still queued for its own turn.
  assert.equal(agent.inbox.nextTurn.length, 1);
  assert.equal(textOf(agent.inbox.nextTurn[0]), 'stays a turn');
});

test('edit: replacement keeps the identity and the queue position', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  const kept = await bridge.deliverMessage('session-queue', 'keep', 'followup');
  const target = await bridge.deliverMessage('session-queue', 'wrong words', 'followup');

  const result = await bridge.editPendingMessage('session-queue', target.message_id, 'right words');

  assert.equal(result.action, 'edit');
  assert.equal(result.message_id, target.message_id);
  assert.equal(result.index, 1);
  assert.equal(result.target, 'next-turn');
  assert.equal(agent.inbox.nextTurn.length, 2);
  assert.equal(agent.inbox.nextTurn.map(textOf).join('|'), 'keep|right words');
  // The surviving identity is the original one, so nothing tracking it breaks.
  assert.equal(String(agent.inbox.nextTurn[1].id), target.message_id);
  assert.equal(String(agent.inbox.nextTurn[0].id), kept.message_id);
  assert.equal(agent.inbox.hasPending, true);
});

test('edit: empty replacement text is refused and the message is untouched', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  const queued = await bridge.deliverMessage('session-queue', 'original', 'followup');

  await assert.rejects(
    () => bridge.editPendingMessage('session-queue', queued.message_id, '   '),
    expectCode('EMPTY_MESSAGE'),
  );
  assert.equal(textOf(agent.inbox.nextTurn[0]), 'original');
});

test('withdraw: removes exactly one pending message and leaves the rest', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  const first = await bridge.deliverMessage('session-queue', 'first', 'followup');
  const doomed = await bridge.deliverMessage('session-queue', 'doomed', 'followup');

  const result = await bridge.withdrawPendingMessage('session-queue', doomed.message_id);

  assert.equal(result.action, 'withdraw');
  assert.equal(result.message_id, doomed.message_id);
  assert.equal(result.index, 1);
  assert.equal(result.previous.target, 'next-turn');
  assert.equal(agent.inbox.nextTurn.length, 1);
  assert.equal(String(agent.inbox.nextTurn[0].id), first.message_id);
  assert.equal(result.queue.nextTurn, 1);
  assert.equal(result.queue.nextStep, 0);
});

test('withdraw: does not cancel the active turn', async () => {
  const agent = makeAgent({ status: 'running' });
  const bridge = makeBridgeWith(agent);
  const queued = await bridge.deliverMessage('session-queue', 'drop me', 'steer');

  await bridge.withdrawPendingMessage('session-queue', queued.message_id);

  assert.equal(agent.inbox.hasPending, false);
  assert.equal(agent.status, 'running');
  // DSH's own cancellation clears *all* pending input; withdrawal must not.
  assert.equal(agent.native.events.filter((event) => event.type === 'agent/inbox/spliced').length, 2);
});

test('errors: an identity this session never queued is reported as unknown', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);

  // No inbox history at all: the id cannot have come from this session.
  for (const action of ['promotePendingMessage', 'withdrawPendingMessage']) {
    await assert.rejects(
      () => bridge[action]('session-queue', 'not-a-real-id'),
      expectCode('MESSAGE_ID_UNKNOWN'),
    );
  }
  await assert.rejects(
    () => bridge.editPendingMessage('session-queue', 'not-a-real-id', 'text'),
    expectCode('MESSAGE_ID_UNKNOWN'),
  );
  assert.equal(agent.inbox.hasPending, false);
});

test('errors: a stale identity in a used session is reported as not pending', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  await bridge.deliverMessage('session-queue', 'present', 'followup');

  for (const action of ['promotePendingMessage', 'withdrawPendingMessage']) {
    await assert.rejects(
      () => bridge[action]('session-queue', 'not-a-real-id'),
      expectCode('MESSAGE_NOT_PENDING'),
    );
  }
  // The failed mutations changed nothing.
  assert.equal(agent.inbox.nextTurn.length, 1);
  assert.equal(textOf(agent.inbox.nextTurn[0]), 'present');
});

test('errors: an admitted message reports that it is already in the transcript', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  const queued = await bridge.deliverMessage('session-queue', 'about to run', 'steer');

  // The boundary claims it and DSH appends it as a durable user message.
  const claimed = agent.inbox.claim('next-step', 1);
  for (const message of claimed) agent.session.append('user/message', message);

  for (const action of ['promotePendingMessage', 'withdrawPendingMessage']) {
    await assert.rejects(
      () => bridge[action]('session-queue', queued.message_id),
      expectCode('MESSAGE_ALREADY_ADMITTED'),
    );
  }
});

test('errors: a withdrawn message is reported as not pending on a second attempt', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  const queued = await bridge.deliverMessage('session-queue', 'withdraw me', 'followup');
  await bridge.withdrawPendingMessage('session-queue', queued.message_id);

  await assert.rejects(
    () => bridge.withdrawPendingMessage('session-queue', queued.message_id),
    expectCode('MESSAGE_NOT_PENDING'),
  );
});

test('errors: a message discarded by cancellation is not re-delivered', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  const queued = await bridge.deliverMessage('session-queue', 'cancelled away', 'followup');

  await bridge.cancelTask('session-queue');

  assert.equal(agent.inbox.hasPending, false);
  await assert.rejects(
    () => bridge.promotePendingMessage('session-queue', queued.message_id),
    expectCode('MESSAGE_NOT_PENDING'),
  );
  assert.equal(agent.inbox.hasPending, false);
});

test('errors: a concurrent claim is reported as already admitted, not a double delivery', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  const queued = await bridge.deliverMessage('session-queue', 'race me', 'steer');

  // Simulate a step boundary claiming the message between the bridge's read
  // and its mutation: the real inbox appends it as a transcript message, and
  // the native `replace` then reports "not pending".
  const realReplace = agent.inbox.replace.bind(agent.inbox);
  agent.inbox.replace = (id, message) => {
    for (const claimed of agent.inbox.claim('next-step', 1)) {
      agent.session.append('user/message', claimed);
    }
    return realReplace(id, message);
  };

  await assert.rejects(
    () => bridge.editPendingMessage('session-queue', queued.message_id, 'too late'),
    expectCode('MESSAGE_ALREADY_ADMITTED'),
  );
  // Exactly one copy existed and it was claimed exactly once.
  assert.equal(agent.inbox.nextStep.length, 0);
  assert.equal(agent.inbox.nextTurn.length, 0);
  assert.equal(agent.native.events.filter((event) => event.type === 'user/message').length, 1);
  // The edit never landed.
  assert.equal(agent.native.events.some((event) => JSON.stringify(event.data).includes('too late')), false);
});

test('errors: a concurrently withdrawn message is reported as not pending', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  const queued = await bridge.deliverMessage('session-queue', 'race me', 'steer');

  // The message is withdrawn by someone else between the read and the
  // mutation. Nothing was admitted, so the refusal must not claim it was.
  const realReplace = agent.inbox.replace.bind(agent.inbox);
  agent.inbox.replace = (id, message) => {
    agent.inbox.remove(queued.message_id);
    return realReplace(id, message);
  };

  await assert.rejects(
    () => bridge.editPendingMessage('session-queue', queued.message_id, 'too late'),
    (error) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, 'MESSAGE_NOT_PENDING');
      return true;
    },
  );
  assert.equal(agent.inbox.hasPending, false);
});

test('errors: a refusal the queue cannot explain leaves the message pending', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  const first = await bridge.deliverMessage('session-queue', 'first', 'followup');
  const second = await bridge.deliverMessage('session-queue', 'second', 'followup');

  // The native operation refuses while the identity is still listed. The
  // bridge must not invent a cause it cannot prove, and must never re-send to
  // "recover": the queue is left exactly as it was.
  agent.inbox.replace = () => false;

  await assert.rejects(
    () => bridge.editPendingMessage('session-queue', second.message_id, 'edited'),
    (error) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, 'MESSAGE_NOT_PENDING');
      return true;
    },
  );
  assert.equal(agent.inbox.nextTurn.length, 2);
  assert.equal(agent.inbox.nextTurn.map(textOf).join('|'), 'first|second');
  assert.equal(String(agent.inbox.nextTurn[0].id), first.message_id);
});

test('errors: a missing inbox is refused instead of guessing', async () => {
  const agent = makeAgent();
  delete agent.inbox;
  const bridge = makeBridgeWith(agent);

  await assert.rejects(
    () => bridge.deliverMessage('session-queue', 'hello'),
    expectCode('INBOX_UNAVAILABLE'),
  );
});

test('errors: session_id is required for queue operations', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);

  await assert.rejects(() => bridge.listPendingMessages('   '), expectCode('SESSION_REQUIRED'));
  await assert.rejects(() => bridge.promotePendingMessage('   ', 'id'), expectCode('SESSION_REQUIRED'));
  await assert.rejects(() => bridge.withdrawPendingMessage('   ', 'id'), expectCode('SESSION_REQUIRED'));
  await assert.rejects(() => bridge.editPendingMessage('   ', 'id', 'text'), expectCode('SESSION_REQUIRED'));
});

test('errors: message_id is required for queue operations', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);

  await assert.rejects(() => bridge.promotePendingMessage('session-queue', '  '), expectCode('MESSAGE_ID_REQUIRED'));
  await assert.rejects(() => bridge.withdrawPendingMessage('session-queue', ''), expectCode('MESSAGE_ID_REQUIRED'));
  await assert.rejects(
    () => bridge.editPendingMessage('session-queue', '  ', 'text'),
    expectCode('MESSAGE_ID_REQUIRED'),
  );
});

test('compat: sendMessage still accepts and reports accepted=true', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);

  const result = await bridge.sendMessage('session-queue', 'legacy call');

  assert.deepEqual(result, { session_id: 'session-queue', accepted: true });
  assert.equal(agent.inbox.nextTurn.length, 1);
  assert.equal(textOf(agent.inbox.nextTurn[0]), 'legacy call');
});

test('compat: a goal control message stays a plain followup', async () => {
  const agent = makeAgent();
  agent.session.events = [];
  const bridge = makeBridgeWith(agent);

  // Goal delivery goes through the same queue as manual messages; pinning it
  // to followup is what keeps goal metadata and manual steering consistent.
  const result = await bridge.deliverMessage('session-queue', 'GOAL START: demo', 'followup');

  assert.equal(result.target, 'next-turn');
  assert.equal(agent.inbox.nextStep.length, 0);
  assert.equal(agent.inbox.nextTurn.length, 1);
});

test('queue and transcript agree: a claimed message leaves the queue exactly once', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  const steered = await bridge.deliverMessage('session-queue', 'one shot', 'steer');

  const claimed = agent.inbox.claim('next-step', 1);
  for (const message of claimed) agent.session.append('user/message', message);

  assert.equal(agent.inbox.hasPending, false);
  const admitted = agent.native.events.filter((event) => event.type === 'user/message');
  assert.equal(admitted.length, 1);
  assert.equal(String(admitted[0].data.id), steered.message_id);
  await assert.rejects(
    () => bridge.withdrawPendingMessage('session-queue', steered.message_id),
    expectCode('MESSAGE_ALREADY_ADMITTED'),
  );
});

test('harness sanity: deliverMessage uses DSH send(), not a private queue', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  let sends = 0;
  const realSend = agent.send.bind(agent);
  agent.send = (message, target, wakeup) => {
    sends += 1;
    return realSend(message, target, wakeup);
  };

  await bridge.deliverMessage('session-queue', 'via send', 'steer');

  assert.equal(sends, 1);
  assert.equal(agent.wakes, 1);
});

// ── read-only listing (review point 2) ────────────────────────────────────────

/** A bridge over a session that is NOT live but has a persisted inbox log. */
function makeColdBridge({ events = [], resumeCalls = [] } = {}) {
  const services = {
    workspaceRegistry: { list: () => [] },
    // No live agent at all: reading must not create one.
    agents: {
      get: () => undefined,
      list: () => [],
      resume: async (input) => {
        resumeCalls.push(input);
        throw new Error('listing must never resume an agent');
      },
    },
    sessions: { list: () => [], get: () => undefined },
    sessionPersistence: {
      list: async () => [],
      open: async () => ({
        header: { id: 'session-cold', createdAt: Date.now(), cwd: WORKSPACE },
        read: async () => ({ events }),
        close: async () => {},
      }),
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  };
  const ctx = {
    get: (key) => services[key],
    agents: services.agents,
    sessions: services.sessions,
    sessionPersistence: services.sessionPersistence,
    agentDefaultModel: services.agentDefaultModel,
    sessionTitle: undefined,
    on: () => {},
  };
  return new Bridge(ctx, { sessionMaxItems: 5, sessionMaxChars: 200, resultMaxItems: 10, resultMaxChars: 500 }, { debug() {}, info() {}, warn() {}, error() {} });
}

test('read-only: listing a cold session reads the durable log and never resumes an agent', async () => {
  // A durable inbox history: one next-turn insert, then one next-step insert.
  const turn = userMessage('queued turn');
  const step = userMessage('queued steering');
  const events = [
    { type: 'agent/inbox/spliced', seq: 0, time: 1, data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [turn] } },
    { type: 'agent/inbox/spliced', seq: 1, time: 2, data: { target: 'next-step', start: 0, removedCount: 0, inserted: [step] } },
  ];
  const resumeCalls = [];
  const bridge = makeColdBridge({ events, resumeCalls });

  const listed = await bridge.listPendingMessages('session-cold');

  assert.deepEqual(resumeCalls, [], 'listPendingMessages must not resume or create an agent');
  assert.equal(listed.live, false);
  assert.equal(listed.total, 2);
  assert.equal(listed.agent_status, undefined);
  assert.equal(listed.next_step.length, 1);
  assert.equal(listed.next_step[0].message_id, String(step.id));
  assert.equal(listed.next_step[0].text, 'queued steering');
  assert.equal(listed.next_turn[0].message_id, String(turn.id));
  // The same identity/version vocabulary as the live path.
  assert.match(listed.next_turn[0].version, /^[0-9a-f]{64}$/);
});

test('read-only: a durable withdrawal is reflected, not a stale count', async () => {
  const kept = userMessage('kept');
  const dropped = userMessage('dropped');
  const events = [
    { type: 'agent/inbox/spliced', seq: 0, time: 1, data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [kept, dropped] } },
    { type: 'agent/inbox/spliced', seq: 1, time: 2, data: { target: 'next-turn', start: 1, removedCount: 1, inserted: [] } },
  ];
  const bridge = makeColdBridge({ events });

  const listed = await bridge.listPendingMessages('session-cold');

  assert.equal(listed.total, 1);
  assert.equal(listed.next_turn[0].message_id, String(kept.id));
});

// ── message versioning (review point 5) ───────────────────────────────────────

test('version: a matching expected_version allows the edit', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  const queued = await bridge.deliverMessage('session-queue', 'before', 'followup');

  const result = await bridge.editPendingMessage('session-queue', queued.message_id, 'after', queued.version);

  assert.equal(textOf(agent.inbox.nextTurn[0]), 'after');
  assert.notEqual(result.version, queued.version);
});

test('version: a stale expected_version refuses the edit and changes nothing', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  const queued = await bridge.deliverMessage('session-queue', 'mine', 'followup');

  // Another client edits the same identity first.
  await bridge.editPendingMessage('session-queue', queued.message_id, 'theirs');

  await assert.rejects(
    () => bridge.editPendingMessage('session-queue', queued.message_id, 'mine again', queued.version),
    expectCode('MESSAGE_VERSION_CONFLICT'),
  );
  assert.equal(textOf(agent.inbox.nextTurn[0]), 'theirs');
});

test('version: a stale expected_version refuses withdrawal and steering too', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  const queued = await bridge.deliverMessage('session-queue', 'original', 'followup');
  await bridge.editPendingMessage('session-queue', queued.message_id, 'changed by someone else');

  await assert.rejects(
    () => bridge.withdrawPendingMessage('session-queue', queued.message_id, queued.version),
    expectCode('MESSAGE_VERSION_CONFLICT'),
  );
  await assert.rejects(
    () => bridge.promotePendingMessage('session-queue', queued.message_id, queued.version),
    expectCode('MESSAGE_VERSION_CONFLICT'),
  );
  // Still exactly one pending copy, untouched.
  assert.equal(agent.inbox.hasPending, true);
  assert.equal(textOf(agent.inbox.nextTurn[0]), 'changed by someone else');
});

test('version: an omitted expected_version keeps the plain behaviour', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  const queued = await bridge.deliverMessage('session-queue', 'original', 'followup');

  await bridge.editPendingMessage('session-queue', queued.message_id, 'edited without a version');

  assert.equal(textOf(agent.inbox.nextTurn[0]), 'edited without a version');
});

// ── non-text content is never dropped (review point 3) ────────────────────────

/** A queued message that carries an attachment beside its text. */
function attachmentMessage(text) {
  return createUserMessage({
    content: [
      { type: 'text', text },
      { type: 'image', ref: { id: 'img-1' } },
    ],
    source: { kind: 'user' },
  });
}

test('non-text: an edit that would drop an attachment is refused, not silently applied', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  const attachment = attachmentMessage('look at this');
  agent.inbox.splice('next-turn', 0, 0, [attachment]);

  await assert.rejects(
    () => bridge.editPendingMessage('session-queue', String(attachment.id), 'text only now'),
    expectCode('MESSAGE_EDIT_NON_TEXT'),
  );
  // The original content is intact, attachment included.
  assert.equal(agent.inbox.nextTurn.length, 1);
  assert.equal(agent.inbox.nextTurn[0].content.length, 2);
  assert.equal(agent.inbox.nextTurn[0].content[1].type, 'image');
});

test('non-text: listing marks a message whose content cannot be re-sent verbatim', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  const attachment = attachmentMessage('with image');
  agent.inbox.splice('next-turn', 0, 0, [attachment]);

  const listed = await bridge.listPendingMessages('session-queue');

  assert.equal(listed.next_turn[0].non_text, true);
  assert.equal(listed.next_turn[0].text, 'with image');
});

test('non-text: withdrawal is still allowed, because it drops nothing silently', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  const attachment = attachmentMessage('with image');
  agent.inbox.splice('next-turn', 0, 0, [attachment]);

  const result = await bridge.withdrawPendingMessage('session-queue', String(attachment.id));

  assert.equal(result.action, 'withdraw');
  assert.equal(agent.inbox.hasPending, false);
});

test('non-text: the replacement message is deeply frozen like a fresh one', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  const queued = await bridge.deliverMessage('session-queue', 'mutable?', 'followup');

  await bridge.editPendingMessage('session-queue', queued.message_id, 'frozen now');

  const replacement = agent.inbox.nextTurn[0];
  assert.ok(Object.isFrozen(replacement), 'the message itself must be frozen');
  assert.ok(Object.isFrozen(replacement.content), 'the content array must be frozen');
  assert.ok(Object.isFrozen(replacement.content[0]), 'each content block must be frozen');
});

// ── supervised-Goal control messages stay authoritative (review point 4) ──────

/** A Goal control envelope in the shape src/goal.ts builds. */
function goalControlMessage(revision) {
  return userMessage(
    `[Goal] rev ${revision} · standard\n\nDisplay this as a single Goal card: "Goal rev ${revision}".\n\n` +
      `Supervised identity: goal_id=goal-x revision=${revision} mode=standard.`,
  );
}

/** Seed a Goal record so the bridge knows the current revision. */
function seedGoal(bridge, sessionId, revision) {
  bridge['goalStore'].put({
    goal_id: 'goal-x',
    session_id: sessionId,
    workspace: WORKSPACE,
    goal: 'g',
    plan: undefined,
    mode: 'standard',
    revision,
    revisions: [],
    constraints: {},
    completed_action_kinds: [],
    deferred_step_ids: [],
    blockers: [],
    history: [],
    created_at: 'x',
    updated_at: 'x',
  });
}

test('goal: editing a Goal control message is refused with a pointer to dsh_update_goal', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  const message = goalControlMessage(1);
  agent.inbox.splice('next-turn', 0, 0, [message]);
  seedGoal(bridge, 'session-queue', 1);

  await assert.rejects(
    () => bridge.editPendingMessage('session-queue', String(message.id), 'a competing goal'),
    (error) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, 'GOAL_MESSAGE_PROTECTED');
      assert.match(error.message, /dsh_update_goal/);
      return true;
    },
  );
  assert.equal(textOf(agent.inbox.nextTurn[0]), textOf(message));
});

test('goal: withdrawing a Goal control message is refused as well', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  const message = goalControlMessage(1);
  agent.inbox.splice('next-turn', 0, 0, [message]);
  seedGoal(bridge, 'session-queue', 1);

  await assert.rejects(
    () => bridge.withdrawPendingMessage('session-queue', String(message.id)),
    expectCode('GOAL_MESSAGE_PROTECTED'),
  );
  assert.equal(agent.inbox.hasPending, true);
});

test('goal: a superseded Goal message is refused as stale, never sent back to the turn', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  const superseded = goalControlMessage(1);
  agent.inbox.splice('next-turn', 0, 0, [superseded]);
  // The record has moved on to revision 2.
  seedGoal(bridge, 'session-queue', 2);

  await assert.rejects(
    () => bridge.promotePendingMessage('session-queue', String(superseded.id)),
    (error) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, 'GOAL_MESSAGE_STALE');
      assert.match(error.message, /dsh_update_goal/);
      return true;
    },
  );
  // It is still parked where it was; nothing was re-steered into the turn.
  assert.equal(agent.inbox.nextStep.length, 0);
  assert.equal(agent.inbox.nextTurn.length, 1);
  assert.equal(agent.steerCount, 0);
});

test('goal: listing marks the Goal revision and whether it is stale', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  agent.inbox.splice('next-turn', 0, 0, [goalControlMessage(1), userMessage('an ordinary note')]);
  seedGoal(bridge, 'session-queue', 2);

  const listed = await bridge.listPendingMessages('session-queue');

  const goal = listed.next_turn.find((row) => row.goal_message !== undefined);
  assert.equal(goal.goal_message.revision, 1);
  assert.equal(goal.goal_message.goal_id, 'goal-x');
  assert.equal(goal.goal_message.stale, true);
  const ordinary = listed.next_turn.find((row) => row.text === 'an ordinary note');
  assert.equal(ordinary.goal_message, undefined);
});

test('goal: an ordinary message is unaffected by Goal protection', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  seedGoal(bridge, 'session-queue', 3);
  const ordinary = await bridge.deliverMessage('session-queue', 'just a note', 'followup');

  await bridge.editPendingMessage('session-queue', ordinary.message_id, 'edited note');
  await bridge.withdrawPendingMessage('session-queue', ordinary.message_id);

  assert.equal(agent.inbox.hasPending, false);
});

// ── steer failure handling (review point 2) ───────────────────────────────────

test('steer: a missing native steer method is refused before anything is queued', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  const queued = await bridge.deliverMessage('session-queue', 'keep me queued', 'followup');
  const splicesBefore = agent.native.events.filter((event) => event.type === 'agent/inbox/spliced').length;

  delete agent.steer;

  await assert.rejects(
    () => bridge.promotePendingMessage('session-queue', queued.message_id),
    expectCode('STEER_UNAVAILABLE'),
  );
  // The capability check runs before the remove, so nothing moved at all.
  assert.equal(agent.inbox.nextTurn.length, 1);
  assert.equal(textOf(agent.inbox.nextTurn[0]), 'keep me queued');
  assert.equal(agent.native.events.filter((event) => event.type === 'agent/inbox/spliced').length, splicesBefore);
});

test('steer: a missing send method is refused before anything is queued', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  const queued = await bridge.deliverMessage('session-queue', 'keep me too', 'followup');

  delete agent.send;

  await assert.rejects(
    () => bridge.promotePendingMessage('session-queue', queued.message_id),
    expectCode('STEER_UNAVAILABLE'),
  );
  assert.equal(agent.inbox.nextTurn.length, 1);
  assert.equal(textOf(agent.inbox.nextTurn[0]), 'keep me too');
});

test('steer: a throw before the message is queued restores it to its position', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  await bridge.deliverMessage('session-queue', 'earlier turn', 'followup');
  const queued = await bridge.deliverMessage('session-queue', 'restore me', 'followup');
  const originalObject = agent.inbox.nextTurn[1];

  // DSH rejected the steer and never inserted anything.
  agent.steer = () => {
    throw new Error('steering is closed for this turn');
  };

  await assert.rejects(
    () => bridge.promotePendingMessage('session-queue', queued.message_id),
    (error) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, 'STEER_REDELIVERY_FAILED');
      assert.equal(error.details.delivery_status, 'not_delivered');
      assert.equal(error.details.recovery, 'restored');
      return true;
    },
  );

  // The identical object is back at its recorded position, exactly once.
  assert.equal(agent.inbox.nextTurn.length, 2);
  assert.equal(agent.inbox.nextTurn[1], originalObject);
  assert.equal(String(agent.inbox.nextTurn[1].id), queued.message_id);
  assert.equal(textOf(agent.inbox.nextTurn[1]), 'restore me');
  assert.equal(agent.inbox.nextStep.length, 0);
  const copies = [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
    .filter((message) => String(message.id) === queued.message_id).length;
  assert.equal(copies, 1, 'recovery must not duplicate the identity');
});

test('steer: a throw after the message is queued is not duplicated', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  const queued = await bridge.deliverMessage('session-queue', 'already delivered', 'followup');

  // DSH accepted the steering, then a later phase threw. Re-sending here would
  // deliver the same text twice.
  const realSteer = agent.steer.bind(agent);
  agent.steer = (message) => {
    realSteer(message);
    throw new Error('post-delivery bookkeeping failed');
  };

  await assert.rejects(
    () => bridge.promotePendingMessage('session-queue', queued.message_id),
    (error) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, 'STEER_REDELIVERY_FAILED');
      assert.equal(error.details.delivery_status, 'queued');
      return true;
    },
  );

  // Exactly one pending copy, and NO restore happened.
  assert.equal(agent.inbox.nextStep.length, 1);
  assert.equal(agent.inbox.nextTurn.length, 0);
  const copies = [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
    .filter((message) => String(message.id) === queued.message_id).length;
  assert.equal(copies, 1);
});

test('steer: a throw after admission is reported as admitted, not re-queued', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  const queued = await bridge.deliverMessage('session-queue', 'claimed already', 'followup');

  const realSteer = agent.steer.bind(agent);
  agent.steer = (message) => {
    realSteer(message);
    // A boundary claims and admits it, then the call throws.
    for (const claimed of agent.inbox.claim('next-step', 1)) {
      agent.session.append('user/message', claimed);
    }
    throw new Error('turn closed during steering');
  };

  await assert.rejects(
    () => bridge.promotePendingMessage('session-queue', queued.message_id),
    (error) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, 'STEER_REDELIVERY_FAILED');
      assert.equal(error.details.delivery_status, 'admitted');
      return true;
    },
  );

  assert.equal(agent.inbox.hasPending, false);
  assert.equal(agent.native.events.filter((event) => event.type === 'user/message').length, 1);
});

test('steer: an unprovable restore reports recovery_required instead of claiming no loss', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  const queued = await bridge.deliverMessage('session-queue', 'cannot be put back', 'followup');

  // The steer throws, and a different message now occupies the freed slot, so
  // re-appending would land the wrong object at the recorded position.
  agent.steer = () => {
    const other = userMessage('an interloper');
    agent.inbox.splice('next-turn', 0, 1, [other]);
    throw new Error('steering refused');
  };

  await assert.rejects(
    () => bridge.promotePendingMessage('session-queue', queued.message_id),
    (error) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, 'STEER_RECOVERY_REQUIRED');
      assert.equal(error.details.recovery, 'recovery_required');
      assert.equal(error.details.delivery_status, 'not_delivered');
      // The text is handed back for a manual re-send, and the message never
      // claims to be intact.
      assert.match(error.details.text, /cannot be put back/);
      return true;
    },
  );
  // The target is gone from the queue: only the interloper remains, and the
  // error said so rather than pretending the message is still parked.
  const queuedIds = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].map((message) => String(message.id));
  assert.equal(queuedIds.includes(queued.message_id), false);
  assert.ok(agent.inbox.nextTurn.some((message) => textOf(message) === 'an interloper'));
});

test('steer: a recovery whose insert is refused reports recovery_required', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  const queued = await bridge.deliverMessage('session-queue', 'insert will fail', 'followup');

  const realSplice = agent.inbox.splice.bind(agent.inbox);
  let steerThrew = false;
  agent.steer = () => {
    steerThrew = true;
    throw new Error('steering refused');
  };
  // Refuse only the restore insertion, after the removal already happened.
  agent.inbox.splice = (target, start, deleteCount, inserted) => {
    if (steerThrew && (inserted ?? []).length > 0) throw new Error('inbox is closing');
    return realSplice(target, start, deleteCount, inserted);
  };

  await assert.rejects(
    () => bridge.promotePendingMessage('session-queue', queued.message_id),
    expectCode('STEER_RECOVERY_REQUIRED'),
  );
  assert.equal(agent.inbox.hasPending, false);
});

// ── consumption faster than the receipt (steer claimed at once) ───────────────

test('delivery: a steer claimed before the receipt reports admitted, not a failure', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  // Simulate the boundary claiming and admitting the message inside send():
  // this is what a step boundary does to a steer at the very next step, and it
  // used to produce a false DELIVERY_NOT_ACCEPTED.
  const realSend = agent.send.bind(agent);
  agent.send = (message, target, wakeup) => {
    realSend(message, target, wakeup);
    for (const claimed of agent.inbox.claim(target, 1)) {
      agent.session.append('user/message', claimed);
    }
  };

  const result = await bridge.deliverMessage('session-queue', 'claim me immediately', 'steer');

  assert.equal(result.accepted, true, 'accepted must stay true: DSH did accept it');
  assert.equal(result.state, 'admitted', 'it was claimed before the receipt, so it is not queued now');
  assert.equal(result.message_id.length > 0, true);
  assert.match(result.note, /already claimed/);
  assert.doesNotMatch(result.note, /not yet part of the transcript/);
  // Exactly one copy: it is in the transcript and nowhere in the queue.
  assert.equal(agent.inbox.hasPending, false);
  const admitted = agent.native.events.filter((event) => event.type === 'user/message');
  assert.equal(admitted.length, 1);
  assert.equal(String(admitted[0].data.id), result.message_id);
  assert.equal(result.queue.nextTurn, 0);
  assert.equal(result.queue.nextStep, 0);
});

test('delivery: a followup claimed before the receipt also reports admitted', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  const realSend = agent.send.bind(agent);
  agent.send = (message, target, wakeup) => {
    realSend(message, target, wakeup);
    for (const claimed of agent.inbox.claim(target, 1)) agent.session.append('user/message', claimed);
  };

  const result = await bridge.deliverMessage('session-queue', 'consumed at once', 'followup');

  assert.equal(result.accepted, true);
  assert.equal(result.state, 'admitted');
  assert.equal(agent.native.events.filter((event) => event.type === 'user/message').length, 1);
});

test('delivery: a genuinely lost message still reports DELIVERY_NOT_ACCEPTED', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  // The message never lands in the inbox and never reaches the transcript:
  // that is the real failure this check exists for.
  agent.send = () => {};

  await assert.rejects(
    () => bridge.deliverMessage('session-queue', 'never lands', 'steer'),
    expectCode('DELIVERY_NOT_ACCEPTED'),
  );
  assert.equal(agent.inbox.hasPending, false);
  assert.equal(agent.native.events.filter((event) => event.type === 'user/message').length, 0);
});

test('delivery: an unrelated earlier message does not masquerade as this one', async () => {
  const agent = makeAgent();
  const bridge = makeBridgeWith(agent);
  // An older, different message is already in the transcript.
  const earlier = userMessage('an earlier admitted message');
  agent.session.append('user/message', earlier);
  agent.send = () => {};

  await assert.rejects(
    () => bridge.deliverMessage('session-queue', 'never lands either', 'steer'),
    expectCode('DELIVERY_NOT_ACCEPTED'),
  );
});

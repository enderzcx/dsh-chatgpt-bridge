/**
 * Evidence that DSH's own Agent inbox already provides every queue operation
 * this feature needs. These tests drive the REAL `ReactLoopInbox` from the
 * installed `@deepseek-ai/dsh-agent-loop`, so the bridge is not inventing a
 * queue or re-implementing the agent loop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeNativeInbox, textOf, userMessage } from '../helpers/queue-harness.mjs';
import { replaceText } from '../../lib/inbox.js';

test('native: steer appends to next-step, followup appends to next-turn', () => {
  const { inbox } = makeNativeInbox();
  const steer = userMessage('steer me');
  const followup = userMessage('follow me');

  inbox.splice('next-step', Number.POSITIVE_INFINITY, 0, [steer]);
  inbox.splice('next-turn', Number.POSITIVE_INFINITY, 0, [followup]);

  assert.equal(inbox.nextStep.length, 1);
  assert.equal(inbox.nextTurn.length, 1);
  assert.equal(textOf(inbox.nextStep[0]), 'steer me');
  assert.equal(textOf(inbox.nextTurn[0]), 'follow me');
  assert.equal(inbox.hasPending, true);
});

test('native: claiming drains next-step first, and one next-turn only when asked', () => {
  const { inbox } = makeNativeInbox();
  const a = userMessage('step A');
  const b = userMessage('step B');
  const turn = userMessage('own turn');
  inbox.splice('next-step', 0, 0, [a, b]);
  inbox.splice('next-turn', 0, 0, [turn]);

  // A same-turn boundary consumes pending steering but no queued turn.
  const steered = inbox.claim('next-step', 7);
  // Compare primitives: the real class is evaluated in a separate vm realm, so
  // its array prototypes are not this realm's.
  assert.equal(steered.map((m) => String(m.id)).join(','), [a, b].map((m) => String(m.id)).join(','));
  assert.equal(inbox.nextTurn.length, 1);

  // A turn boundary additionally consumes exactly one queued turn.
  const claimed = inbox.claim('next-turn', 8);
  assert.equal(claimed.map((m) => String(m.id)).join(','), String(turn.id));
  assert.equal(inbox.hasPending, false);
});

test('native: promoting a queued next-turn message preserves its identity', () => {
  const { inbox, events } = makeNativeInbox();
  const queued = userMessage('promote me');
  inbox.splice('next-turn', Number.POSITIVE_INFINITY, 0, [queued]);
  const before = inbox.nextTurn[0];

  // The bridge's promote: remove from next-turn, insert at the head of next-step.
  inbox.splice('next-turn', 0, 1, []);
  inbox.splice('next-step', 0, 0, [before]);

  assert.equal(inbox.nextTurn.length, 0);
  assert.equal(inbox.nextStep.length, 1);
  // Same object, same identity: a move, never a copy that could be delivered twice.
  assert.equal(inbox.nextStep[0], before);
  assert.equal(String(inbox.nextStep[0].id), String(queued.id));
  assert.equal(textOf(inbox.nextStep[0]), 'promote me');

  const splices = events
    .filter((event) => event.type === 'agent/inbox/spliced')
    .slice(-2)
    .map((event) => event.data.target);
  assert.equal(splices.join(','), 'next-turn,next-step');
});

test('native: promoting reorders an existing next-step message to the front', () => {
  const { inbox } = makeNativeInbox();
  const first = userMessage('already first');
  const second = userMessage('should overtake');
  inbox.splice('next-step', 0, 0, [first, second]);

  const target = inbox.nextStep[1];
  inbox.splice('next-step', 1, 1, []);
  inbox.splice('next-step', 0, 0, [target]);

  assert.equal(inbox.nextStep.map(textOf).join('|'), 'should overtake|already first');
  assert.equal(inbox.nextStep.length, 2);
});

test('native: replace edits in place and keeps the identity', () => {
  const { inbox } = makeNativeInbox();
  const original = userMessage('before edit');
  inbox.splice('next-turn', Number.POSITIVE_INFINITY, 0, [original]);

  const edited = Object.freeze({
    id: original.id,
    role: 'user',
    content: [{ type: 'text', text: 'after edit' }],
    source: original.source,
  });
  assert.equal(inbox.replace(original.id, edited), true);

  assert.equal(inbox.nextTurn.length, 1);
  assert.equal(inbox.nextTurn[0].id, original.id);
  assert.equal(textOf(inbox.nextTurn[0]), 'after edit');
  assert.equal(inbox.hasPending, true);
});

test('native: remove withdraws one message across both lists', () => {
  const { inbox } = makeNativeInbox();
  const kept = userMessage('keep me');
  const dropped = userMessage('drop me');
  inbox.splice('next-step', 0, 0, [dropped]);
  inbox.splice('next-turn', 0, 0, [kept]);

  assert.equal(inbox.remove(dropped.id), true);
  assert.equal(inbox.nextStep.length, 0);
  assert.equal(inbox.nextTurn.length, 1);

  // A second removal of the same identity is a refusal, not a silent success:
  // this is what stops the bridge from double-delivering after a race.
  assert.equal(inbox.remove(dropped.id), false);
  assert.equal(inbox.replace(dropped.id, dropped), false);
});

test('native: clear cancels all pending input, next-step first', () => {
  const { inbox, events } = makeNativeInbox();
  inbox.splice('next-step', 0, 0, [userMessage('s')]);
  inbox.splice('next-turn', 0, 0, [userMessage('t')]);

  inbox.clear();

  assert.equal(inbox.hasPending, false);
  assert.equal(
    events
      .filter((event) => event.type === 'agent/inbox/spliced')
      .slice(-2)
      .map((event) => event.data.target)
      .join(','),
    'next-step,next-turn',
  );
});

test('native: one identity may not be pending twice', () => {
  const { inbox } = makeNativeInbox();
  const message = userMessage('only once');
  inbox.splice('next-step', 0, 0, [message]);

  assert.throws(() => inbox.splice('next-turn', 0, 0, [message]), /already pending/);
});

test('native: remove + steer preserves promotion order, unlike head-insertion', () => {
  const { inbox } = makeNativeInbox();
  const a = userMessage('A');
  const b = userMessage('B');
  const c = userMessage('C');
  inbox.splice('next-turn', 0, 0, [a, b, c]);

  // DSH's own queue `steer` action: remove(id) then steer(sameMessage), which
  // appends to next-step. Promoting in queue order must keep that order.
  const promote = (message) => {
    inbox.remove(message.id);
    inbox.splice('next-step', Number.POSITIVE_INFINITY, 0, [message]);
  };
  promote(a);
  promote(b);
  promote(c);

  assert.equal(inbox.nextStep.map(textOf).join('|'), 'A|B|C');
  assert.equal(inbox.nextTurn.length, 0);

  // The previous hand-rolled head-insertion is what reversed that order.
  const { inbox: second } = makeNativeInbox();
  const x = userMessage('X');
  const y = userMessage('Y');
  second.splice('next-turn', 0, 0, [x, y]);
  for (const message of [x, y]) {
    second.splice('next-turn', 0, 1, []);
    second.splice('next-step', 0, 0, [message]);
  }
  assert.equal(second.nextStep.map(textOf).join('|'), 'Y|X', 'head insertion reverses');
});

test('native: replaceText refuses non-text content instead of dropping it', () => {
  const withImage = {
    id: 'm-1',
    role: 'user',
    content: [{ type: 'text', text: 'see this' }, { type: 'image', ref: { id: 'i' } }],
    source: { kind: 'user' },
  };
  assert.throws(() => replaceText(withImage, 'text only'), /non-text blocks/);

  const textOnly = { id: 'm-2', role: 'user', content: [{ type: 'text', text: 'old' }], source: { kind: 'user' } };
  const replaced = replaceText(textOnly, 'new');
  assert.equal(replaced.id, 'm-2', 'identity is preserved for inbox.replace');
  assert.equal(textOf(replaced), 'new');
  assert.ok(Object.isFrozen(replaced));
  assert.ok(Object.isFrozen(replaced.content));
  assert.ok(Object.isFrozen(replaced.content[0]));
});

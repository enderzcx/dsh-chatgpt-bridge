import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../../lib/bridge.js';

const QUESTION = {
  id: 'inner-1',
  question: 'pick',
  options: [{ label: 'A' }, { label: 'B' }],
  multiSelect: false,
};

const log = { debug() {}, info() {}, warn() {}, error() {} };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeHarness({ web }) {
  const handlers = new Map();
  const services = {
    workspaceRegistry: { list: () => [] },
    agents: { get: () => undefined, list: () => [] },
    sessions: { list: () => [], get: () => undefined },
    sessionPersistence: { list: async () => [] },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    ...(web
      ? {
          apiProxy: {
            events: { mux: async function* () {} },
            respond: async () => ({ accepted: true }),
          },
        }
      : {}),
  };
  const ctx = {
    get: (key) => services[key],
    agents: services.agents,
    sessions: services.sessions,
    sessionPersistence: services.sessionPersistence,
    agentDefaultModel: services.agentDefaultModel,
    on: (event, handler) => {
      handlers.set(event, handler);
      return () => {};
    },
    inject: () => ({}),
    effect: (execute) => execute(),
  };
  const bridge = new Bridge(
    ctx,
    { sessionMaxItems: 5, sessionMaxChars: 200, resultMaxItems: 10, resultMaxChars: 500 },
    log,
  );
  bridge.start();
  bridge['managed'].add('session-a');
  return { bridge, ask: handlers.get('user-questions/request') };
}

const request = () => ({
  agent: { id: 'session-a', session: { snapshotEvents: () => [] } },
  questions: [QUESTION],
});

test('headless: the bridge parks the question and does not call the Web answerer', async () => {
  const { bridge, ask } = makeHarness({ web: false });
  let nextCalled = false;
  const parked = ask(request(), () => {
    nextCalled = true;
    return Promise.resolve({ answers: [] });
  });
  await tick();
  assert.equal(nextCalled, false);
  assert.equal(bridge['questions'].size, 1);
  await bridge.answerQuestion('question-1', 'session-a', { selected: ['A'] });
  assert.deepEqual(await parked, { answers: [{ id: 'inner-1', selected: ['A'] }] });
  assert.equal(bridge['questions'].size, 0);
});

test('web mode: the Web surface owns the composer and the bridge stays answerable', async () => {
  const { bridge, ask } = makeHarness({ web: true });
  let nextCalled = false;
  let resolveWeb;
  const webAnswer = new Promise((resolve) => {
    resolveWeb = resolve;
  });
  const parked = ask(request(), () => {
    nextCalled = true;
    return webAnswer;
  });
  await tick();
  assert.equal(nextCalled, true, 'the Web prompt must be started so the browser can answer');
  assert.equal(bridge['questions'].size, 1, 'dsh_answer_question must still find the question');
  await bridge.answerQuestion('question-1', 'session-a', { selected: ['B'] });
  assert.deepEqual((await parked).answers, [{ id: 'inner-1', selected: ['B'] }]);
  resolveWeb({ answers: [{ id: 'inner-1', selected: ['A'] }] });
  await tick();
  assert.deepEqual((await parked).answers, [{ id: 'inner-1', selected: ['B'] }], 'first answer wins');
});

test('web mode: a Web answerer failure keeps the question parked for the bridge', async () => {
  const { bridge, ask } = makeHarness({ web: true });
  const parked = ask(request(), () =>
    Promise.reject(new Error('no user-questions answerer accepted the request')));
  await tick();
  await tick();
  assert.equal(bridge['questions'].size, 1);
  await bridge.answerQuestion('question-1', 'session-a', { selected: ['A'] });
  assert.deepEqual((await parked).answers, [{ id: 'inner-1', selected: ['A'] }]);
});

test('web mode: an unmanaged session still falls through to the Web answerer', async () => {
  const { ask } = makeHarness({ web: true });
  let nextCalled = false;
  await ask(
    { agent: { id: 'session-other', session: { snapshotEvents: () => [] } }, questions: [QUESTION] },
    () => {
      nextCalled = true;
      return Promise.resolve({ answers: [] });
    },
  );
  assert.equal(nextCalled, true);
});

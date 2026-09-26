/**
 * MCP-level assertions for the steering / pending-input surface.
 *
 * These drive the REAL MCP protocol over the same Streamable HTTP transport the
 * production bridge uses, because the compatibility contract that matters is
 * what an already-connected client receives on the wire — not what a bridge
 * method returns in-process.
 *
 * The agent behind the bridge is the shared queue harness whose inbox is DSH's
 * real `ReactLoopInbox`, so the tool results describe DSH's own queue.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpServer } from '../../lib/http.js';
import { createMcpServer } from '../../lib/mcp.js';
import { Bridge } from '../../lib/bridge.js';
import { makeQueueAgent, textOf } from '../helpers/queue-harness.mjs';

const TOKEN = 'test-token-for-steering-mcp';
const WORKSPACE = 'D:\\Agent\\agent_workplace\\mix_workspace';

/** A live bridge whose only session is the queue agent under test. */
function makeBridgeFor(agent) {
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
  return new Bridge(ctx, { sessionMaxItems: 5, sessionMaxChars: 200, resultMaxItems: 10, resultMaxChars: 500 }, {
    debug() {},
    info() {},
    warn() {},
    error() {},
  });
}

/** Parse one JSON tool result, failing loudly on a non-JSON body. */
async function call(target, name, args) {
  const result = await target.callTool({ name, arguments: args });
  const text = result.content?.find((part) => part.type === 'text')?.text ?? '{}';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`tool ${name} did not return JSON: ${text.slice(0, 300)}`);
  }
  return { parsed, isError: result.isError === true, raw: text };
}

describe('steering over real MCP', () => {
  let handle;
  let client;
  let agent;

  before(async () => {
    agent = makeQueueAgent({ status: 'running' });
    agent.session.header = { id: agent.id, createdAt: Date.now(), cwd: WORKSPACE };
    const bridge = makeBridgeFor(agent);
    const log = { debug() {}, info() {}, warn() {}, error() {} };
    handle = await startHttpServer(
      () => createMcpServer(bridge, { resultMaxChars: 100, resultMaxItems: 10, sessionMaxItems: 5, sessionMaxChars: 200 }, log),
      { host: '127.0.0.1', port: 0, authMode: 'token', authToken: TOKEN },
      log,
    );
    client = new Client({ name: 'steering-mcp-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(handle.url), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    }));
  });

  after(async () => {
    await client?.close();
    await handle?.close();
  });

  test('the four pending-input tools are advertised with expected_version and delivery', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const name of [
      'dsh_send_message',
      'dsh_list_pending_messages',
      'dsh_promote_pending_message',
      'dsh_edit_pending_message',
      'dsh_withdraw_pending_message',
    ]) {
      assert.ok(names.includes(name), `${name} must be advertised`);
    }
    const send = tools.find((tool) => tool.name === 'dsh_send_message');
    assert.ok(send.inputSchema.properties.delivery, 'delivery must be an advertised parameter');
    assert.equal(send.inputSchema.properties.delivery.enum.join(','), 'followup,steer');
    const promote = tools.find((tool) => tool.name === 'dsh_promote_pending_message');
    assert.ok(promote.inputSchema.properties.expected_version, 'expected_version must be advertised');
  });

  test('legacy client: dsh_send_message still returns accepted:true (a strict old-shape read)', async () => {
    const { parsed, isError } = await call(client, 'dsh_send_message', {
      session_id: agent.id,
      message: 'a legacy client sends this',
    });

    assert.equal(isError, false);
    // The exact field an already-connected client used to depend on. A strict
    // reader that only looks at session_id + accepted must keep working.
    assert.equal(parsed.accepted, true);
    assert.equal(parsed.session_id, agent.id);
    assert.equal(Object.hasOwn(parsed, 'accepted'), true, 'accepted must be present, not merely truthy by absence');
    // The richer fields are additive and must not have replaced it.
    assert.match(parsed.message_id, /^[0-9a-f-]{36}$/);
    assert.equal(parsed.state, 'queued');
    assert.equal(parsed.delivery, 'followup');
    assert.equal(parsed.target, 'next-turn');
    assert.match(parsed.version, /^[0-9a-f]{64}$/);
  });

  test('legacy client: an explicit steer also reports accepted:true with its real target', async () => {
    const { parsed, isError } = await call(client, 'dsh_send_message', {
      session_id: agent.id,
      message: 'steer this over MCP',
      delivery: 'steer',
    });

    assert.equal(isError, false);
    assert.equal(parsed.accepted, true);
    assert.equal(parsed.target, 'next-step');
    assert.equal(parsed.delivery, 'steer');
    assert.equal(parsed.state, 'queued');
  });

  test('accepted:true means queued, not understood: the transcript stays empty', async () => {
    const before = agent.native.events.filter((event) => event.type === 'user/message').length;

    const { parsed } = await call(client, 'dsh_send_message', {
      session_id: agent.id,
      message: 'queued but not yet read',
    });

    assert.equal(parsed.accepted, true);
    assert.equal(parsed.note.includes('not yet part of the transcript'), true);
    assert.equal(agent.native.events.filter((event) => event.type === 'user/message').length, before);
  });

  test('list, edit with expected_version, withdraw and promote round-trip over MCP', async () => {
    const sent = await call(client, 'dsh_send_message', {
      session_id: agent.id,
      message: 'manage me over MCP',
      delivery: 'followup',
    });
    assert.equal(sent.parsed.accepted, true);

    const listed = await call(client, 'dsh_list_pending_messages', { session_id: agent.id });
    assert.equal(listed.isError, false);
    const row = listed.parsed.next_turn.find((item) => item.message_id === sent.parsed.message_id);
    assert.ok(row, 'the delivered message must be listed with its id');
    assert.equal(row.version, sent.parsed.version);

    const edited = await call(client, 'dsh_edit_pending_message', {
      session_id: agent.id,
      message_id: row.message_id,
      message: 'edited over MCP',
      expected_version: row.version,
    });
    assert.equal(edited.isError, false);
    assert.equal(edited.parsed.action, 'edit');
    assert.notEqual(edited.parsed.version, row.version);

    const promoted = await call(client, 'dsh_promote_pending_message', {
      session_id: agent.id,
      message_id: row.message_id,
    });
    assert.equal(promoted.isError, false);
    assert.equal(promoted.parsed.action, 'steer');
    assert.equal(promoted.parsed.target, 'next-step');

    const withdrawn = await call(client, 'dsh_withdraw_pending_message', {
      session_id: agent.id,
      message_id: row.message_id,
    });
    assert.equal(withdrawn.isError, false);
    assert.equal(withdrawn.parsed.action, 'withdraw');
  });

  test('a stale expected_version is refused over the wire with a readable code', async () => {
    const sent = await call(client, 'dsh_send_message', {
      session_id: agent.id,
      message: 'version guard over MCP',
    });
    const stale = sent.parsed.version;
    await call(client, 'dsh_edit_pending_message', {
      session_id: agent.id,
      message_id: sent.parsed.message_id,
      message: 'changed by another client',
    });

    const refused = await call(client, 'dsh_edit_pending_message', {
      session_id: agent.id,
      message_id: sent.parsed.message_id,
      message: 'my stale write',
      expected_version: stale,
    });

    assert.equal(refused.isError, true);
    assert.equal(refused.parsed.error.code, 'MESSAGE_VERSION_CONFLICT');
    assert.equal(refused.parsed.error.details.expected_version, stale);
  });

  test('the wire still carries the legacy empty-message refusal', async () => {
    const refused = await call(client, 'dsh_send_message', { session_id: agent.id, message: '   ' });

    assert.equal(refused.isError, true);
    assert.equal(refused.parsed.error.code, 'EMPTY_MESSAGE');
  });

  test('the queue is not duplicated by the MCP round trip', async () => {
    const listed = await call(client, 'dsh_list_pending_messages', { session_id: agent.id });
    const ids = [...listed.parsed.next_turn, ...listed.parsed.next_step].map((row) => row.message_id);
    assert.equal(new Set(ids).size, ids.length, 'every pending identity must be unique');
    // And the listing agrees with the native queue.
    assert.equal(ids.length, agent.inbox.nextTurn.length + agent.inbox.nextStep.length);
    assert.equal(agent.inbox.nextStep.every((message) => typeof textOf(message) === 'string'), true);
  });
});

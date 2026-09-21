/**
 * Direct-operation MCP integration tests.
 *
 * These drive the REAL MCP protocol over the SAME Streamable HTTP transport the
 * production bridge uses (bearer auth, session id, tools/list, tools/call), not
 * a direct function call. They prove three things a unit test cannot:
 *
 *   1. the direct tools are actually advertised over the wire, with honest
 *      annotations (a write must not be advertised as read-only);
 *   2. a full read → write/edit → read-back round trip works through MCP;
 *   3. the direct path touches NO DSH session and NO agent: every Bridge method
 *      is a spy that fails the test if it is called.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpServer } from '../../lib/http.js';
import { createMcpServer } from '../../lib/mcp.js';
import { createDirectOpsRuntime } from '../../lib/direct/tools.js';
import { resolveConfig } from '../../lib/config.js';
import { makeSandbox, writeFixture } from '../helpers/direct-harness.mjs';

const TOKEN = 'test-token-for-direct-ops-mcp';

/** A Bridge stand-in whose every method fails loudly: the direct path must not use it. */
function forbiddenBridge() {
  const called = [];
  const handler = {
    get(_target, property) {
      if (typeof property !== 'string') return undefined;
      if (property === 'workspaceGuard') return {};
      return (...args) => {
        called.push({ method: property, args });
        throw new Error(`Bridge.${property} must not be called by a direct-operation tool`);
      };
    },
  };
  return { bridge: new Proxy({}, handler), called };
}

describe('direct-operation MCP surface', () => {
  let sandbox;
  let handle;
  let client;
  let bridgeCalls;
  let counter;

  before(async () => {
    sandbox = await makeSandbox();
    await mkdir(join(sandbox.root, 'src'), { recursive: true });
    await writeFixture(join(sandbox.root, 'src/app.txt'), 'hello\nworld\n');

    const cfg = resolveConfig(
      {
        transport: 'http',
        host: '127.0.0.1',
        port: 0,
        authMode: 'token',
        authToken: TOKEN,
        logLevel: 'error',
        directOps: {
          enabled: true,
          allowWrites: true,
          roots: [sandbox.root],
          writableRoots: [sandbox.root],
          exec: {
            enabled: true,
            allowedCommands: ['echo'],
            cwdRoots: [sandbox.root],
            network: 'deny',
            filesystem: 'roots',
            sandbox: 'preferred',
          },
        },
      },
      { DSH_HOME: sandbox.base },
    );

    const { bridge, called } = forbiddenBridge();
    bridgeCalls = called;
    counter = { listWorkspaces: 0, createSession: 0, getSession: 0, sendMessage: 0, startGoal: 0 };
    const directOps = createDirectOpsRuntime(cfg.directOps);

    handle = await startHttpServer(
      () => createMcpServer(bridge, cfg, { debug() {}, info() {}, warn() {}, error() {} }, directOps),
      { host: '127.0.0.1', port: 0, authMode: 'token', authToken: TOKEN },
      { debug() {}, info() {}, warn() {}, error() {} },
    );

    client = new Client({ name: 'direct-ops-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(handle.url), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    }));
  });

  after(async () => {
    await client?.close().catch(() => {});
    await handle?.close().catch(() => {});
    await sandbox?.cleanup();
  });

  async function call(name, args = {}, target = client) {
    const result = await target.callTool({ name, arguments: args });
    const text = result.content?.find((part) => part.type === 'text')?.text ?? '{}';
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A transport-level failure is not a policy refusal: surface it plainly
      // rather than pretending a code came back.
      throw new Error(`tool ${name} did not return JSON: ${text.slice(0, 300)}`);
    }
    return { parsed, isError: result.isError === true, raw: text };
  }

  test('the endpoint advertises the direct tools with honest annotations', async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    for (const name of [
      'dsh_read_text_file',
      'dsh_write_text_file',
      'dsh_edit_text_file',
      'dsh_run_command',
      'dsh_operator_roots',
      'dsh_operator_reload_policy',
    ]) {
      assert.ok(byName.has(name), `${name} must be advertised`);
    }

    const read = byName.get('dsh_read_text_file');
    assert.equal(read.annotations.readOnlyHint, true);
    assert.equal(read.annotations.destructiveHint, false);

    for (const name of ['dsh_write_text_file', 'dsh_edit_text_file']) {
      const tool = byName.get(name);
      assert.equal(tool.annotations.readOnlyHint, false, `${name} must not claim read-only`);
      assert.equal(tool.annotations.destructiveHint, true, `${name} must announce that it destroys data`);
    }

    const exec = byName.get('dsh_run_command');
    assert.equal(exec.annotations.readOnlyHint, false);
    assert.equal(exec.annotations.destructiveHint, true);
    assert.equal(exec.annotations.openWorldHint, true, 'exec must announce an open world');

    // The agent-control surface must still be there.
    assert.ok(byName.has('dsh_start_goal'));
    assert.ok(byName.has('dsh_wait_goal'));

    // No caller-supplied authorization parameters anywhere in the direct surface.
    for (const name of ['dsh_read_text_file', 'dsh_write_text_file', 'dsh_edit_text_file', 'dsh_run_command']) {
      const properties = Object.keys(byName.get(name).inputSchema?.properties ?? {});
      for (const forbidden of ['allowed_roots', 'approved', 'root', 'roots', 'force', 'sudo', 'as_admin']) {
        assert.ok(!properties.includes(forbidden), `${name} must not accept ${forbidden}`);
      }
    }
  });

  test('MCP round trip: read → edit → read back → create', async () => {
    const target = join(sandbox.root, 'src/app.txt');

    const first = await call('dsh_read_text_file', { path: target });
    assert.equal(first.isError, false);
    assert.equal(first.parsed.content, 'hello\nworld\n');
    const version = first.parsed.file_version.sha256;

    const edited = await call('dsh_edit_text_file', {
      path: target,
      old_text: 'world',
      new_text: 'MCP',
      expected_sha256: version,
    });
    assert.equal(edited.isError, false, edited.raw);
    assert.equal(edited.parsed.replacements, 1);

    const second = await call('dsh_read_text_file', { path: target });
    assert.equal(second.parsed.content, 'hello\nMCP\n');
    assert.equal(second.parsed.file_version.sha256, edited.parsed.file_version.sha256);
    assert.equal(await readFile(target, 'utf8'), 'hello\nMCP\n');

    const created = await call('dsh_write_text_file', {
      path: join(sandbox.root, 'src/new.txt'),
      content: 'created through MCP\n',
      mode: 'create',
    });
    assert.equal(created.isError, false, created.raw);
    assert.equal(created.parsed.created, true);
    assert.equal(await readFile(join(sandbox.root, 'src/new.txt'), 'utf8'), 'created through MCP\n');
  });

  test('MCP round trip: stale version is refused through the wire', async () => {
    const target = join(sandbox.root, 'src/stale.txt');
    await writeFixture(target, 'v1\n');
    const read = await call('dsh_read_text_file', { path: target });
    await writeFixture(target, 'v2-written-by-someone-else\n');

    const refused = await call('dsh_write_text_file', {
      path: target,
      content: 'clobber\n',
      mode: 'overwrite',
      expected_sha256: read.parsed.file_version.sha256,
    });
    assert.equal(refused.isError, true);
    assert.equal(refused.parsed.error.code, 'VERSION_CONFLICT');
    assert.equal(await readFile(target, 'utf8'), 'v2-written-by-someone-else\n');

    // A blind overwrite is refused before it can touch anything.
    const blind = await call('dsh_write_text_file', { path: target, content: 'blind\n', mode: 'overwrite' });
    assert.equal(blind.isError, true);
    assert.equal(blind.parsed.error.code, 'READ_REQUIRED');
    assert.equal(await readFile(target, 'utf8'), 'v2-written-by-someone-else\n');

    // The default mode is create, so an omitted mode never replaces a file.
    const defaulted = await call('dsh_write_text_file', { path: target, content: 'default-mode\n' });
    assert.equal(defaulted.isError, true);
    assert.equal(defaulted.parsed.error.code, 'WRITE_CONFLICT');
    assert.equal(await readFile(target, 'utf8'), 'v2-written-by-someone-else\n');
  });

  test('MCP round trip: escapes and disabled capabilities are refused with codes', async () => {
    const outside = await call('dsh_read_text_file', { path: '/etc/hosts' });
    assert.equal(outside.isError, true);
    assert.equal(outside.parsed.error.code, 'PATH_OUTSIDE_ROOTS');

    const relative = await call('dsh_read_text_file', { path: 'etc/hosts' });
    assert.equal(relative.parsed.error.code, 'INVALID_PATH');

    // Write the credential file first, so the refusal is about the denylist and
    // not merely about the file being absent.
    await writeFixture(join(sandbox.root, '.env'), 'SECRET_TOKEN=zzz\n');
    const denied = await call('dsh_read_text_file', { path: join(sandbox.root, '.env') });
    assert.equal(denied.parsed.error.code, 'PATH_DENIED');
    assert.ok(!denied.raw.includes('zzz'), 'a refusal must never echo the protected content');
    const deniedWrite = await call('dsh_write_text_file', { path: join(sandbox.root, '.env'), content: 'x' });
    assert.equal(deniedWrite.parsed.error.code, 'PATH_DENIED');

    const notAllowed = await call('dsh_run_command', { cmd: 'rm', args: ['-rf', sandbox.root] });
    assert.equal(notAllowed.parsed.error.code, 'COMMAND_NOT_ALLOWED');
    assert.ok(!notAllowed.raw.includes('rm -rf'), 'refusal must not echo a composed command line');
  });

  test('MCP round trip: an allowlisted command runs and reports result shape', async () => {
    const ok = await call('dsh_run_command', { cmd: 'echo', args: ['from-mcp'], cwd: sandbox.root });
    assert.equal(ok.isError, false, ok.raw);
    assert.equal(ok.parsed.exit_code, 0);
    assert.equal(ok.parsed.stdout.trim(), 'from-mcp');
    assert.equal(typeof ok.parsed.timed_out, 'boolean');
    assert.ok(Array.isArray(ok.parsed.env_keys));
    assert.ok(!ok.parsed.env_keys.includes('DSH_HOME'), 'child env must not inherit DSH secrets');

    const timeout = await call('dsh_run_command', { cmd: 'echo', args: ['x'], cwd: sandbox.root, timeout_ms: 1 });
    assert.equal(timeout.isError, false, timeout.raw);
    assert.equal(typeof timeout.parsed.timed_out, 'boolean');
  });

  test('the policy report is read-only and states the real boundaries', async () => {
    const report = await call('dsh_operator_roots');
    assert.equal(report.isError, false, report.raw);
    assert.equal(report.parsed.enabled, true);
    assert.equal(report.parsed.writes_enabled, true);
    assert.equal(report.parsed.exec_enabled, true);
    assert.deepEqual(report.parsed.roots.map((root) => root.writable), [true]);
    assert.equal(report.parsed.network, 'deny');
    assert.ok(Array.isArray(report.parsed.notes) && report.parsed.notes.length > 0);
    assert.ok(
      report.parsed.notes.some((note) => /server-side configuration/i.test(note)),
      'the report must state that roots are server-side, not caller-supplied',
    );
  });

  test('no direct tool creates a DSH session or touches the agent bridge', async () => {
    // Exercise every direct tool once, then assert the bridge was never used.
    await call('dsh_read_text_file', { path: join(sandbox.root, 'src/app.txt') });
    const created = await call('dsh_write_text_file', { path: join(sandbox.root, 'no-session.txt'), content: 'x' });
    await call('dsh_edit_text_file', {
      path: join(sandbox.root, 'no-session.txt'),
      old_text: 'x',
      new_text: 'y',
      expected_sha256: created.parsed.file_version.sha256,
    });
    await call('dsh_run_command', { cmd: 'echo', args: ['x'], cwd: sandbox.root });
    await call('dsh_operator_roots');

    assert.deepEqual(bridgeCalls, [], 'direct tools must not call any Bridge (agent/session/goal) method');
    assert.deepEqual(counter, { listWorkspaces: 0, createSession: 0, getSession: 0, sendMessage: 0, startGoal: 0 });
  });

  test('a disabled direct policy refuses over the wire instead of disappearing silently', async () => {
    const disabledCfg = resolveConfig(
      {
        transport: 'http',
        host: '127.0.0.1',
        port: 0,
        authMode: 'token',
        authToken: TOKEN,
        logLevel: 'error',
        directOps: { enabled: false, allowWrites: false, roots: [sandbox.root], writableRoots: [] },
      },
      { DSH_HOME: sandbox.base },
    );
    const { bridge } = forbiddenBridge();
    const isolated = await startHttpServer(
      () => createMcpServer(bridge, disabledCfg, { debug() {}, info() {}, warn() {}, error() {} }, createDirectOpsRuntime(disabledCfg.directOps)),
      { host: '127.0.0.1', port: 0, authMode: 'token', authToken: TOKEN },
      { debug() {}, info() {}, warn() {}, error() {} },
    );
    const isolatedClient = new Client({ name: 'disabled-policy-test', version: '1.0.0' });
    try {
      await isolatedClient.connect(new StreamableHTTPClientTransport(new URL(isolated.url), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }));
      const result = await isolatedClient.callTool({
        name: 'dsh_read_text_file',
        arguments: { path: join(sandbox.root, 'src/app.txt') },
      });
      assert.equal(result.isError, true);
      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.error.code, 'DIRECT_OPS_DISABLED');
    } finally {
      await isolatedClient.close().catch(() => {});
      await isolated.close().catch(() => {});
    }
  });

  test('reload_policy refuses when the host configured no policy file', async () => {
    const result = await call('dsh_operator_reload_policy');
    assert.equal(result.isError, true);
    assert.equal(result.parsed.error.code, 'INVALID_ARGUMENT');
    assert.match(result.parsed.error.message, /policyFile/i);
  });
});

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig, bridgeHttpUrl, isLoopbackHost, normalizeSocketHostname } from '../../lib/config.js';
import { startHttpServer } from '../../lib/http.js';
import { RuntimeManager } from '../../lib/control/runtime-manager.js';
import { FakeTunnelRuntime } from '../../lib/control/fake-tunnel-runtime.js';

const tmp = mkdtempSync(join(tmpdir(), 'dsh-listener-host-'));
const handles = [];
const managers = [];
const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

test('socket hostname normalization removes URL-only IPv6 brackets without changing listener semantics', () => {
  assert.equal(normalizeSocketHostname('127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeSocketHostname('localhost'), 'localhost');
  assert.equal(normalizeSocketHostname('::1'), '::1');
  assert.equal(normalizeSocketHostname('[::1]'), '::1');
  assert.equal(normalizeSocketHostname('::'), '::');
  assert.equal(normalizeSocketHostname('[::]'), '::');
  assert.equal(isLoopbackHost(normalizeSocketHostname('[::1]')), true);
  assert.equal(isLoopbackHost(normalizeSocketHostname('[::]')), false);
});

after(async () => {
  for (const manager of managers) {
    try { await manager.dispose(); } catch {}
  }
  for (const handle of handles) {
    try { await handle.close(); } catch {}
  }
  rmSync(tmp, { recursive: true, force: true });
});

test('authMode none accepts loopback listener spellings and rejects exposed hosts at config resolution', () => {
  for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackHost(host), true, host);
    assert.doesNotThrow(() => resolveConfig({ transport: 'http', host, authMode: 'none' }, {}));
  }
  for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.test']) {
    assert.equal(isLoopbackHost(host), false, host);
    assert.throws(
      () => resolveConfig({ transport: 'http', host, authMode: 'none' }, {}),
      new RegExp(`authMode none.*loopback.*non-loopback host ${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
  }
});

test('HTTP startup independently refuses authMode none on a non-loopback listener', async () => {
  await assert.rejects(
    startHttpServer(
      () => { throw new Error('must not create a session'); },
      { host: '0.0.0.0', port: 0, authMode: 'none', authToken: '' },
      silentLog,
    ),
    /authMode none.*loopback.*non-loopback host 0\.0\.0\.0/,
  );
});

test('RuntimeManager probes the listener-compatible IPv4, IPv6, localhost, and wildcard targets', async () => {
  const hosts = ['127.0.0.1', 'localhost', '::1', '0.0.0.0', '::'];
  for (const [index, host] of hosts.entries()) {
    const handle = await startHttpServer(
      () => { throw new Error('probe must not create an MCP session'); },
      { host, port: 0, authMode: 'token', authToken: 'listener-probe-token' },
      silentLog,
    );
    handles.push(handle);
    const expectedUrl = bridgeHttpUrl(host, handle.port);
    assert.equal(handle.url, expectedUrl, `${host}: server and probe URL share one mapping`);
    if (host === '0.0.0.0') assert.match(expectedUrl, /^http:\/\/127\.0\.0\.1:/);
    if (host === '::') assert.match(expectedUrl, /^http:\/\/\[::1\]:/);

    const managerHome = join(tmp, `manager-${index}`);
    const manager = new RuntimeManager({
      dshHome: managerHome,
      bridge: { url: expectedUrl, token: 'listener-probe-token', authMode: 'token' },
      createRuntime: () => new FakeTunnelRuntime(),
      discover: () => ({}),
      logger: silentLog,
    });
    managers.push(manager);
    await manager.refresh();
    const snapshot = manager.getSnapshot();
    assert.equal(snapshot.bridge.url, expectedUrl);
    assert.equal(snapshot.bridge.status, 'running', `${host}: RuntimeManager reaches the live listener`);
    assert.equal(snapshot.bridge.reachable, true);
  }
});

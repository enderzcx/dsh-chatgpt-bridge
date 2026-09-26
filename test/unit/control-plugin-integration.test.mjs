import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { apply } from '../../lib/index.js';
import { ROUTE_BASE } from '../../lib/control/routes.js';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
    server.on('error', reject);
  });
}

async function waitListening(port, timeoutMs = 8000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      await response.text();
      return;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  throw last ?? new Error('bridge never started');
}

function makeReq({ method = 'GET', url = '/', headers = {}, remoteAddress = '127.0.0.1' }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress };
  return req;
}

function makeRes() {
  const res = { statusCode: 0, body: '', headers: {}, ended: false };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.end = (s) => { res.body = s; res.ended = true; };
  return res;
}

test('plugin apply wires the management API and serves GET /status', async () => {
  const home = mkdtempSync(join(process.cwd(), '.ctrl-int-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const port = await freePort();
  const disposers = [];
  const routes = [];
  const mockWebServer = {
    register: (route) => {
      routes.push(route);
      return () => {
        const index = routes.indexOf(route);
        if (index >= 0) routes.splice(index, 1);
      };
    },
  };
  const services = {
    agents: { get: () => undefined, list: () => [] },
    sessions: { list: () => [], get: () => undefined },
    sessionPersistence: { list: async () => [] },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  };
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get: (key) => services[key],
    agents: services.agents,
    sessions: services.sessions,
    sessionPersistence: services.sessionPersistence,
    agentDefaultModel: services.agentDefaultModel,
    on: () => () => true,
    inject: (names, callback) => {
      if (Array.isArray(names) && names.includes('webServer')) {
        const nested = callback({ ...ctx, webServer: mockWebServer });
        if (typeof nested === 'function') disposers.push(nested);
        return () => {};
      }
      return {};
    },
    effect: (execute) => {
      const disposer = execute();
      disposers.push(disposer);
      return disposer;
    },
  };
  try {
    apply(ctx, { transport: 'http', host: '127.0.0.1', port, authMode: 'token', authToken: 'test-token', logLevel: 'error' });
    await waitListening(port);
    const route = routes.find((candidate) => candidate.path === ROUTE_BASE);
    assert.ok(route, 'management route must be registered on the DSH web server');
    const res = makeRes();
    await route.handler(makeReq({ url: ROUTE_BASE + '/status', headers: { host: '127.0.0.1:3080' } }), res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(typeof body.status.overall.status, 'string');
    // A mutation without the CSRF guard header must be rejected.
    const res2 = makeRes();
    await route.handler(
      makeReq({
        method: 'POST',
        url: ROUTE_BASE + '/start',
        headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'content-type': 'application/json' },
      }),
      res2,
    );
    assert.equal(res2.statusCode, 403);
  } finally {
    // Always dispose so the runtime manager poller is released even on failure.
    for (const disposer of [...disposers].reverse()) {
      try {
        await disposer();
      } catch {
        // best-effort during teardown
      }
    }
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

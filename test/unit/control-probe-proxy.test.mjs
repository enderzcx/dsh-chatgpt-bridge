import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect } from 'node:net';

import { probeControlPlane, probeHttpsViaProxy, probeHttpViaProxy } from '../../lib/control/diagnostics.js';
import { selfSignedCert } from '../helpers/self-signed.mjs';

// ------------------------------------------------------------------- helpers
const created = [];
// Every TCP socket the helper servers create is tracked and force-destroyed
// at suite end: an http server's close() waits on connections it does NOT own
// (e.g. the CONNECT proxy's outward pipes), so relying on server.close alone
// can pin the in-process test runner's event loop forever.
const sockets = new Set();
function trackSocket(s) {
  if (s === undefined || s === null) return s;
  sockets.add(s);
  s.on('error', () => {});
  s.once('close', () => sockets.delete(s));
  return s;
}
function watchServer(server) {
  server.on('connection', (s) => trackSocket(s));
  return server;
}

after(async () => {
  for (const s of sockets) {
    try {
      s.destroy();
    } catch {}
  }
  sockets.clear();
  for (const { server } of created) {
    try {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const { server } of created) {
    try {
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    } catch {}
  }
});

function startHttpOrigin(status = 200, record) {
  return new Promise((resolve) => {
    const server = watchServer(createHttpServer((req, res) => {
      if (record) record(req);
      res.statusCode = status;
      res.end('{}');
    }));
    server.listen(0, '127.0.0.1', () => {
      created.push({ server });
      resolve(server);
    });
  });
}

function startHttpsOrigin(cert) {
  return new Promise((resolve) => {
    const seen = [];
    const server = watchServer(createHttpsServer({ key: cert.key, cert: cert.cert }, (req, res) => {
      seen.push({ url: req.url, host: req.headers.host, authorization: req.headers.authorization });
      res.statusCode = 200;
      res.end('{}');
    }));
    server.listen(0, '127.0.0.1', () => {
      created.push({ server });
      resolve({ server, port: server.address().port, seen: () => seen.slice() });
    });
  });
}

function closedPort() {
  return new Promise((resolve) => {
    const server = createHttpServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

/** HTTP forward proxy: records absolute-form request URLs, answers 200. */
function startForwardingProxy() {
  return new Promise((resolve) => {
    const seen = [];
    const server = watchServer(createHttpServer((req, res) => {
      seen.push(req.url);
      res.statusCode = 200;
      res.end('{}');
    }));
    server.listen(0, '127.0.0.1', () => {
      created.push({ server });
      resolve({ port: server.address().port, seen: () => seen.slice() });
    });
  });
}

/** HTTP CONNECT tunnel proxy: records CONNECT targets, then pipes bytes. */
function startConnectProxy() {
  return new Promise((resolve) => {
    const targets = [];
    const server = watchServer(createHttpServer());
    server.on('connect', (req, clientSocket, head) => {
      trackSocket(clientSocket);
      const target = req.url; // "host:port"
      targets.push(target);
      const [host, portStr] = target.split(':');
      const upstream = trackSocket(connect(Number(portStr), host));
      upstream.once('connect', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head !== undefined && head.length > 0) upstream.write(head);
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
      });
      upstream.once('error', () => clientSocket.destroy());
      clientSocket.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => {
      created.push({ server });
      resolve({ port: server.address().port, targets: () => targets.slice() });
    });
  });
}

/** CONNECT proxy that accepts sockets but never completes CONNECT. */
function startHangingProxy() {
  return new Promise((resolve) => {
    const server = watchServer(createHttpServer());
    server.on('connect', (_req, clientSocket) => {
      trackSocket(clientSocket);
      clientSocket.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => {
      created.push({ server });
      resolve(server.address().port);
    });
  });
}

// ------------------------------------------------------------ probe routing
test('probe: proxy disabled - direct probe reaches a local HTTP origin', async () => {
  const origin = await startHttpOrigin(200);
  const result = await probeControlPlane({ baseUrl: `http://127.0.0.1:${origin.address().port}` });
  assert.equal(result.status, 'connected');
});

test('probe: proxy disabled - direct probe to a closed port is unreachable', async () => {
  const port = await closedPort();
  const result = await probeControlPlane({ baseUrl: `http://127.0.0.1:${port}` });
  assert.equal(result.status, 'unreachable');
});

test('probe: loopback target bypasses an enabled proxy (NO_PROXY mirror)', async () => {
  const origin = await startHttpOrigin(200);
  const dead = await closedPort();
  const result = await probeControlPlane({
    baseUrl: `http://127.0.0.1:${origin.address().port}`,
    proxy: { host: '127.0.0.1', port: dead },
  });
  assert.equal(result.status, 'connected', 'loopback must bypass the proxy');
});

test('probe: enabled proxy + dead proxy fails closed (no direct fallback)', async () => {
  const dead = await closedPort();
  const result = await probeControlPlane({
    baseUrl: 'https://control-plane.invalid',
    apiKey: 'sk-test-1234567890',
    proxy: { host: '127.0.0.1', port: dead },
  });
  assert.equal(result.status, 'unreachable');
  assert.equal(result.error, 'proxy-connect-failed');
  assert.equal(result.stage, 'proxy-connect');
  assert.equal(result.proxy, `127.0.0.1:${dead}`);
  // The failure is the proxy failure, not a direct-path class like dns-failed:
  // the probe never silently fell back to a direct request.
  assert.notEqual(result.error, 'dns-failed');
});

test('probe: invalid proxy config is rejected (proxy-invalid), not ignored', async () => {
  const result = await probeControlPlane({ baseUrl: 'https://control-plane.invalid', proxy: { host: '', port: 0 } });
  assert.equal(result.status, 'unreachable');
  assert.equal(result.error, 'proxy-invalid');
});

// ------------------------------------------------------ HTTPS-over-HTTP proxy
test('probe: HTTPS target via HTTP CONNECT proxy succeeds and the proxy saw the CONNECT + the Authorization header crossed TLS', async () => {
  const origin = await startHttpsOrigin(selfSignedCert());
  const proxy = await startConnectProxy();

  const result = await probeHttpsViaProxy(
    new URL(`https://127.0.0.1:${origin.port}/v1/tunnel/tunnel_test?probe=1`),
    { Authorization: 'Bearer sk-test-1234567890' },
    5000,
    { host: '127.0.0.1', port: proxy.port },
    false,
  );

  assert.equal(result.statusCode, 200, 'CONNECT + TLS + GET over the tunnel must yield the origin status');
  assert.deepEqual(proxy.targets(), [`127.0.0.1:${origin.port}`], 'the proxy must receive an HTTP CONNECT for the target origin');
  const seen = origin.seen();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/v1/tunnel/tunnel_test?probe=1', 'the authenticated resource path must survive CONNECT + TLS');
  assert.equal(seen[0].host, `127.0.0.1:${origin.port}`, 'the target Host header must survive CONNECT + TLS');
  assert.equal(seen[0].authorization, 'Bearer sk-test-1234567890', 'Authorization must arrive at the TLS origin through the tunnel');
  // Redaction: the probe result never carries the API key.
  assert.equal(JSON.stringify(result).includes('sk-test-1234567890'), false, 'result must not leak the API key');
});

test('probe: proxy refusing CONNECT yields proxy-connect-failed (never a direct fallback to the origin)', async () => {
  const dead = await closedPort();
  const result = await probeHttpsViaProxy(new URL('https://127.0.0.1:9/'), {}, 5000, { host: '127.0.0.1', port: dead }, false);
  assert.equal(result.error, 'proxy-connect-failed');
  assert.equal(result.stage, 'proxy-connect');
});

test('probe: proxy that never completes CONNECT yields proxy-connect-timeout', async () => {
  const hung = await startHangingProxy();
  const result = await probeHttpsViaProxy(new URL('https://origin.invalid/'), {}, 400, { host: '127.0.0.1', port: hung }, false);
  assert.equal(result.error, 'proxy-connect-timeout');
});

// ----------------------------------------------------------- plain-HTTP proxy
test('probe: plain-HTTP target through an HTTP proxy uses absolute-form GET', async () => {
  const origin = await startHttpOrigin(200);
  const proxy = await startForwardingProxy();
  const result = await probeHttpViaProxy(
    new URL(`http://127.0.0.1:${origin.address().port}/`),
    {},
    5000,
    { host: '127.0.0.1', port: proxy.port },
  );
  assert.equal(result.statusCode, 200);
  assert.equal(proxy.seen().length, 1);
  assert.ok(proxy.seen()[0].startsWith(`http://127.0.0.1:${origin.address().port}/`), 'proxy must see the absolute-form target');
});

// ---------------------------------------------------------------- classification
test('probe: untrusted TLS origin classified as tls-failed (no proxy)', async () => {
  const origin = await startHttpsOrigin(selfSignedCert());
  const result = await probeControlPlane({ baseUrl: `https://127.0.0.1:${origin.port}` });
  assert.equal(result.status, 'unreachable');
  assert.equal(result.error, 'tls-failed');
  assert.equal(result.stage, 'tls');
});

test('probe: 401 from the origin classified as unauthorized / authentication-failed', async () => {
  const origin = await startHttpOrigin(401);
  const result = await probeControlPlane({ baseUrl: `http://127.0.0.1:${origin.address().port}`, apiKey: 'sk-test-1234567890' });
  assert.equal(result.status, 'unauthorized');
  assert.equal(result.error, 'authentication-failed');
  assert.equal(result.statusCode, 401);
});

test('probe: reachable origin returning 5xx stays "connected" (reachability semantics preserved)', async () => {
  const origin = await startHttpOrigin(500);
  const result = await probeControlPlane({ baseUrl: `http://127.0.0.1:${origin.address().port}` });
  assert.equal(result.status, 'connected');
  assert.equal(result.error, 'http-error');
});

test('probe: malformed base URL classified as unreachable', async () => {
  const result = await probeControlPlane({ baseUrl: 'not a url' });
  assert.equal(result.status, 'unreachable');
  assert.equal(result.error, 'http-error');
});

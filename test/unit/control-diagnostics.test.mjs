import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { buildDiagnosticSteps, probeBridge, tcpReachable } from '../../lib/control/diagnostics.js';

const servers = [];
after(async () => {
  for (const server of servers) {
    await new Promise((resolve) => server.close(resolve));
  }
});

function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve(server);
    });
  });
}

test('diagnostics: buildDiagnosticSteps covers all layers', () => {
  const steps = buildDiagnosticSteps({
    detection: { installed: true, executablePath: 'x', version: '0.0.11' },
    bridgeProbe: { listening: true, reachable: true, authenticated: true, status: 'running' },
    tunnelRunning: true,
    tunnelHealthy: true,
    tunnelReady: true,
    runtimeApiKeyConfigured: true,
    controlPlaneBaseUrl: 'https://api.openai.com',
    controlPlaneStatus: 'connected',
    proxyConfigured: false,
    proxyValid: true,
  });
  assert.deepEqual(steps.map((s) => s.id), [
    'tunnel-binary', 'bridge-endpoint', 'bridge-auth', 'tunnel-process', 'tunnel-health',
    'tunnel-ready', 'runtime-api-key', 'openai-control-plane', 'proxy',
  ]);
  assert.equal(steps.every((s) => s.ok), true);
});

test('diagnostics: status probe failure is status-failed, not tunnel-not-running', () => {
  const steps = buildDiagnosticSteps({
    detection: { installed: true, executablePath: 'x', version: '0.0.11' },
    bridgeProbe: { listening: true, reachable: true, authenticated: true, status: 'running' },
    tunnelRunning: false,
    tunnelHealthy: false,
    tunnelReady: false,
    statusProbeFailed: true,
    runtimeApiKeyConfigured: true,
    controlPlaneBaseUrl: 'https://api.openai.com',
    controlPlaneStatus: 'connected',
    proxyConfigured: false,
    proxyValid: true,
  });
  const statusStep = steps.find((s) => s.id === 'status');
  assert.ok(statusStep);
  assert.equal(statusStep.ok, false);
  assert.equal(statusStep.code, 'status-failed');
  const processStep = steps.find((s) => s.id === 'tunnel-process');
  assert.equal(processStep.code, 'status-failed');
  assert.notEqual(processStep.code, 'tunnel-not-running');
  assert.equal(steps.every((s) => s.ok), false);
});

test('diagnostics: missing key marks runtime-api-key step failed', () => {
  const steps = buildDiagnosticSteps({
    detection: { installed: true },
    bridgeProbe: { listening: true, reachable: true, authenticated: true, status: 'running' },
    tunnelRunning: true, tunnelHealthy: true, tunnelReady: true,
    runtimeApiKeyConfigured: false,
    controlPlaneBaseUrl: 'https://api.openai.com',
    controlPlaneStatus: 'connected',
    proxyConfigured: false, proxyValid: true,
  });
  const keyStep = steps.find((s) => s.id === 'runtime-api-key');
  assert.equal(keyStep.ok, false);
  assert.equal(keyStep.code, 'runtime-api-key-missing');
});

test('diagnostics: unauthorized control plane maps to runtime-api-unauthorized', () => {
  const steps = buildDiagnosticSteps({
    detection: { installed: true },
    bridgeProbe: { listening: true, reachable: true, authenticated: true, status: 'running' },
    tunnelRunning: true, tunnelHealthy: true, tunnelReady: true,
    runtimeApiKeyConfigured: true,
    controlPlaneBaseUrl: 'https://api.openai.com',
    controlPlaneStatus: 'unauthorized',
    proxyConfigured: false, proxyValid: true,
  });
  const cp = steps.find((s) => s.id === 'openai-control-plane');
  assert.equal(cp.ok, false);
  assert.equal(cp.code, 'runtime-api-unauthorized');
});

test('diagnostics: probeBridge authenticates against a live server', async () => {
  const server = await startServer((req, res) => {
    if (req.headers.authorization === 'Bearer good-token') {
      res.statusCode = 400;
      res.end('{"error":"session-not-found"}');
    } else {
      res.statusCode = 401;
      res.end('{}');
    }
  });
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/mcp`;
  const ok = await probeBridge({ url, token: 'good-token' });
  assert.equal(ok.listening, true);
  assert.equal(ok.authenticated, true);
  assert.equal(ok.status, 'running');
  const bad = await probeBridge({ url, token: 'wrong-token' });
  assert.equal(bad.authenticated, false);
  assert.equal(bad.status, 'error');
  assert.equal(bad.error, 'bridge-auth-failed');
});

test('diagnostics: probeBridge reports offline when nothing listens', async () => {
  const server = await startServer((_req, res) => res.end());
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const result = await probeBridge({ url: `http://127.0.0.1:${port}/mcp`, token: 't' });
  assert.equal(result.listening, false);
  assert.equal(result.status, 'offline');
});

test('diagnostics: tcpReachable basic', async () => {
  const server = await startServer((_req, res) => res.end());
  const port = server.address().port;
  assert.equal(await tcpReachable('127.0.0.1', port), true);
  assert.equal(await tcpReachable('127.0.0.1', 1), false);
});

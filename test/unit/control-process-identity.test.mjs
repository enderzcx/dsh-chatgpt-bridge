import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProcessIdentity,
  isProcessAlive,
  verifyProcessIdentity,
  processExecutablePath,
  processStartTimeMs,
  START_TIME_TOLERANCE_MS,
} from '../../lib/control/process-identity.js';

const SPAWN_BLOCKED = process.env.DSH_SHELL === '1';

test('process-identity: isProcessAlive for own pid', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(0), false);
});

test('process-identity: createIdentity carries runtimeInstanceId', () => {
  const identity = createProcessIdentity({ pid: 123, executablePath: 'C:/x/tunnel-client.exe', profileName: 'p', tunnelId: 't_1' });
  assert.equal(identity.pid, 123);
  assert.equal(identity.executablePath, 'C:/x/tunnel-client.exe');
  assert.equal(identity.profileName, 'p');
  assert.equal(identity.tunnelId, 't_1');
  assert.ok(identity.runtimeInstanceId.length > 0);
  assert.ok(identity.startedAt.length > 0);
});

test('process-identity: verify own process passes', { skip: SPAWN_BLOCKED ? 'sandbox blocks cross-process spawn' : false }, () => {
  const resolved = processExecutablePath(process.pid) ?? process.execPath;
  const startedAt = processStartTimeMs(process.pid);
  const identity =
    startedAt === undefined
      ? createProcessIdentity({ pid: process.pid, executablePath: resolved })
      : createProcessIdentity({ pid: process.pid, executablePath: resolved, startedAt: new Date(startedAt).toISOString() });
  const result = verifyProcessIdentity(identity);
  assert.equal(result.ok, true);
});

test('process-identity: dead pid fails with not-alive', () => {
  const identity = createProcessIdentity({ pid: 999999999, executablePath: process.execPath });
  const result = verifyProcessIdentity(identity);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not-alive');
});

test('process-identity: wrong executable fails with executable-mismatch', () => {
  // Verify against our own pid but a different executable name; the current
  // executable path will differ from the fabricated one.
  const identity = createProcessIdentity({ pid: process.pid, executablePath: 'C:/nonexistent/tunnel-client.exe' });
  const result = verifyProcessIdentity(identity);
  assert.equal(result.ok, false);
  assert.ok(['executable-mismatch', 'unknown-executable'].includes(result.code));
});

test('process-identity: processExecutablePath resolves own process', { skip: SPAWN_BLOCKED ? 'sandbox blocks cross-process spawn' : false }, () => {
  const path = processExecutablePath(process.pid);
  assert.ok(path !== undefined && path !== '', 'own executable path should resolve');
});

// ---------------------------------------------------- start-time verification
const IDENTITY = (overrides = {}) => ({
  pid: 41001,
  startedAt: new Date(1_700_000_000_000).toISOString(),
  executablePath: 'C:/x/tunnel-client.exe',
  runtimeInstanceId: 'rid-123',
  ...overrides,
});

function probes(overrides = {}) {
  return {
    isAlive: () => true,
    executablePath: () => 'C:/x/tunnel-client.exe',
    startTimeMs: () => 1_700_000_000_000,
    ...overrides,
  };
}

test('process-identity: same pid + exe + start time passes', () => {
  const result = verifyProcessIdentity(IDENTITY(), probes());
  assert.equal(result.ok, true);
  assert.equal(result.code, 'verified');
});

test('process-identity: same pid + different exe fails', () => {
  const result = verifyProcessIdentity(IDENTITY(), probes({ executablePath: () => 'C:/y/other-tunnel.exe' }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'executable-mismatch');
});

test('process-identity: same pid + different start time fails (PID reuse)', () => {
  const result = verifyProcessIdentity(IDENTITY(), probes({ startTimeMs: () => 1_700_000_000_000 + 60_000 }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'start-time-mismatch');
});

test('process-identity: dead pid fails with not-alive (probed)', () => {
  const result = verifyProcessIdentity(IDENTITY(), probes({ isAlive: () => false }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not-alive');
});

test('process-identity: unreadable start time fails closed', () => {
  const result = verifyProcessIdentity(IDENTITY(), probes({ startTimeMs: () => undefined }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'unknown-start-time');
});

test('process-identity: start time within tolerance passes', () => {
  const drift = Math.floor(START_TIME_TOLERANCE_MS * 0.75);
  const result = verifyProcessIdentity(IDENTITY(), probes({ startTimeMs: () => 1_700_000_000_000 + drift }));
  assert.equal(result.ok, true);
});

test('process-identity: start time beyond tolerance fails', () => {
  const result = verifyProcessIdentity(IDENTITY(), probes({ startTimeMs: () => 1_700_000_000_000 + START_TIME_TOLERANCE_MS + 1 }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'start-time-mismatch');
});

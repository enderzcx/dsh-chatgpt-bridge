import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveConfig } from '../../lib/config.js';
import { probeBridge } from '../../lib/control/diagnostics.js';
import { startHttpServer } from '../../lib/http.js';

/**
 * Auth-token single-authority regression tests (bridge-auth-failed fix).
 *
 * Goal: within one bridge runtime lifecycle the MCP server's accepted token
 * equals the runtime-manager probe's token. resolveConfig() is the single
 * authority: server startup and probe both consume its resolved authToken,
 * the token file (once created exclusively) is never overwritten, and a
 * concurrent loser adopts the persisted token instead of diverging.
 */

const tmp = mkdtempSync(join(tmpdir(), 'dsh-auth-token-'));
const handles = [];
after(async () => {
  for (const h of handles) {
    try { await h.close(); } catch {}
  }
  rmSync(tmp, { recursive: true, force: true });
});

const tokenFile = () => join(tmp, 'chatgpt-bridge.token');
const env = (extra = {}) => ({ DSH_HOME: tmp, USERPROFILE: tmp, ...extra });
const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

const childSource = String.raw`
  import { existsSync, writeFileSync } from 'node:fs';
  const { resolveConfig } = await import(process.env.CONFIG_MODULE_URL);
  writeFileSync(process.env.READY_FILE, '', 'utf8');
  while (!existsSync(process.env.GO_FILE)) await new Promise((resolve) => setTimeout(resolve, 1));
  const cfg = resolveConfig({ tokenFile: process.env.TOKEN_FILE }, {});
  process.stdout.write(cfg.authToken);
`;

const delayedWriterSource = String.raw`
  import { writeFileSync } from 'node:fs';
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.WRITE_DELAY_MS)));
  writeFileSync(process.env.TOKEN_FILE, process.env.CANONICAL_TOKEN + '\n', 'utf8');
`;

function spawnResolver({ tokenFile, readyFile, goFile }) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
    env: {
      ...process.env,
      CONFIG_MODULE_URL: pathToFileURL(join(process.cwd(), 'lib', 'config.js')).href,
      TOKEN_FILE: tokenFile,
      READY_FILE: readyFile,
      GO_FILE: goFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`token resolver child failed with exit ${code}: ${stderr.trim()}`));
    });
  });
  return { done };
}

function spawnDelayedWriter({ tokenFile, canonicalToken, delayMs }) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', delayedWriterSource], {
    env: {
      ...process.env,
      TOKEN_FILE: tokenFile,
      CANONICAL_TOKEN: canonicalToken,
      WRITE_DELAY_MS: String(delayMs),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`delayed token writer failed with exit ${code}: ${stderr.trim()}`));
    });
  });
}

async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for token resolver children');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function startAuthServer(authToken) {
  const handle = await startHttpServer(
    () => { throw new Error('session server must not be created by probes'); },
    { host: '127.0.0.1', port: 0, authMode: 'token', authToken },
    silentLog,
  );
  handles.push(handle);
  return handle;
}

test('auth: first resolveConfig generates and persists one token; server and probe share it', async () => {
  const cfg1 = resolveConfig({}, env());
  assert.ok(cfg1.authToken.length >= 24, 'auto-generated token present');
  assert.equal(readFileSync(tokenFile(), 'utf8').trim(), cfg1.authToken, 'token persisted');
  // File is the single authority: a later resolve in the same lifecycle
  // MUST return the same token (no re-generation, no divergence).
  const cfg2 = resolveConfig({}, env());
  assert.equal(cfg2.authToken, cfg1.authToken);
  // Live proof of the invariant: the server started with the resolved token
  // accepts exactly that token from the probe.
  const server = await startAuthServer(cfg1.authToken);
  const url = 'http://127.0.0.1:' + server.port + '/mcp';
  const ok = await probeBridge({ url, token: cfg1.authToken });
  assert.equal(ok.authenticated, true);
  assert.equal(ok.status, 'running');
});

test('auth: an existing token file is used unchanged by server and probe', async () => {
  mkdirSync(tmp, { recursive: true });
  const existingToken = 'file-token-existing-00000000000000';
  writeFileSync(tokenFile(), existingToken + '\n', 'utf8');
  const cfg = resolveConfig({}, env());
  assert.equal(cfg.authToken, existingToken, 'file token wins without env');
  const server = await startAuthServer(cfg.authToken);
  const url = 'http://127.0.0.1:' + server.port + '/mcp';
  const ok = await probeBridge({ url, token: cfg.authToken });
  assert.equal(ok.authenticated, true, 'probe authenticates with the file token');
  assert.equal(readFileSync(tokenFile(), 'utf8').trim(), existingToken, 'file not overwritten');
});

test('auth: DSH_CHATGPT_BRIDGE_TOKEN outranks the file; explicit authToken outranks env', () => {
  writeFileSync(tokenFile(), 'file-token-abcdefghijklmnopqrstuv\n', 'utf8');
  const byEnv = resolveConfig({}, env({ DSH_CHATGPT_BRIDGE_TOKEN: 'env-token-abcdefghijklmnopqrstuv' }));
  assert.equal(byEnv.authToken, 'env-token-abcdefghijklmnopqrstuv', 'env beats file');
  const byExplicit = resolveConfig({ authToken: 'explicit-token-abcdefghijklmnopqrstuv' }, env());
  assert.equal(byExplicit.authToken, 'explicit-token-abcdefghijklmnopqrstuv', 'explicit beats env');
  const customVar = resolveConfig({ authTokenEnv: 'MY_BRIDGE_TOKEN' }, env({ MY_BRIDGE_TOKEN: 'custom-var-token-abcdefghijklmnopq' }));
  assert.equal(customVar.authToken, 'custom-var-token-abcdefghijklmnopq', 'custom authTokenEnv honored');
});

test('auth: wrong bearer token is rejected with 401 (bridge-auth-failed)', async () => {
  const server = await startAuthServer('correct-token-abcdefghijklmnopqrstuvw');
  const url = 'http://127.0.0.1:' + server.port + '/mcp';
  const bad = await probeBridge({ url, token: 'wrong-token' });
  assert.equal(bad.authenticated, false);
  assert.equal(bad.status, 'error');
  assert.equal(bad.error, 'bridge-auth-failed');
  const raw = await fetch(url, { headers: { Authorization: 'Bearer wrong-token' }, signal: AbortSignal.timeout(3000) });
  assert.equal(raw.status, 401);
});

test('auth: correct bearer token reaches the MCP endpoint (non-401)', async () => {
  const server = await startAuthServer('endpoint-token-abcdefghijklmnopqrstuv');
  const url = 'http://127.0.0.1:' + server.port + '/mcp';
  const ok = await probeBridge({ url, token: 'endpoint-token-abcdefghijklmnopqrstuv' });
  assert.equal(ok.authenticated, true);
  const raw = await fetch(url, { headers: { Authorization: 'Bearer endpoint-token-abcdefghijklmnopqrstuv' }, signal: AbortSignal.timeout(3000) });
  assert.notEqual(raw.status, 401, 'endpoint is past auth (400 session-not-found is the expected probe shape)');
});

test('auth: independent processes converge on one canonical token across repeated races', async () => {
  const rounds = 8;
  const processCount = 6;
  for (let round = 0; round < rounds; round += 1) {
    const roundDir = join(tmp, `race-${round}`);
    mkdirSync(roundDir, { recursive: true });
    const sharedTokenFile = join(roundDir, 'bridge.token');
    const goFile = join(roundDir, 'go');
    const children = Array.from({ length: processCount }, (_, index) => {
      const readyFile = join(roundDir, `ready-${index}`);
      return {
        readyFile,
        ...spawnResolver({ tokenFile: sharedTokenFile, readyFile, goFile }),
      };
    });
    await waitUntil(() => children.every(({ readyFile }) => existsSync(readyFile)));
    writeFileSync(goFile, '', 'utf8');
    const tokens = await Promise.all(children.map(({ done }) => done));
    const canonical = readFileSync(sharedTokenFile, 'utf8').trim();
    assert.ok(canonical.length >= 24, `round ${round}: canonical token persisted`);
    assert.equal(tokens.every((token) => token === canonical), true, `round ${round}: every process adopted the canonical token`);
  }
});

test('auth: initial readers stabilize a token file whose exclusive creator is still writing', async () => {
  const concurrentTokenFile = join(tmp, 'concurrent-initial-read.token');
  const canonicalToken = 'concurrent-winner-token-abcdefghijklmnop';
  // Models the exact filesystem state after another process wins O_EXCL: the
  // directory entry is visible, but its small write is not observable yet.
  writeFileSync(concurrentTokenFile, '', 'utf8');
  const writerDone = spawnDelayedWriter({ tokenFile: concurrentTokenFile, canonicalToken, delayMs: 100 });
  const cfg = resolveConfig({ tokenFile: concurrentTokenFile }, env());
  await writerDone;
  assert.equal(cfg.authToken, canonicalToken);
  assert.equal(readFileSync(concurrentTokenFile, 'utf8').trim(), canonicalToken);
});

test('auth: independent processes all adopt an existing valid token unchanged', async () => {
  const roundDir = join(tmp, 'existing-valid-processes');
  mkdirSync(roundDir, { recursive: true });
  const sharedTokenFile = join(roundDir, 'bridge.token');
  const existingToken = 'existing-process-token-abcdefghijklmnop';
  const goFile = join(roundDir, 'go');
  writeFileSync(sharedTokenFile, existingToken + '\n', 'utf8');
  const children = Array.from({ length: 6 }, (_, index) => {
    const readyFile = join(roundDir, `ready-${index}`);
    return { readyFile, ...spawnResolver({ tokenFile: sharedTokenFile, readyFile, goFile }) };
  });
  await waitUntil(() => children.every(({ readyFile }) => existsSync(readyFile)));
  writeFileSync(goFile, '', 'utf8');
  const tokens = await Promise.all(children.map(({ done }) => done));
  assert.deepEqual(tokens, Array.from({ length: 6 }, () => existingToken));
  assert.equal(readFileSync(sharedTokenFile, 'utf8').trim(), existingToken);
});

test('auth: empty and multiline token files fail closed without exposing contents', { timeout: 3000 }, () => {
  const cases = [
    ['', 'empty'],
    ['first-line-token\nsecond-line-secret\n', 'multiline'],
  ];
  for (const [contents, label] of cases) {
    const malformed = join(tmp, `malformed-${label}.token`);
    writeFileSync(malformed, contents, 'utf8');
    const persistentTimestamp = new Date(Date.now() - 60_000);
    utimesSync(malformed, persistentTimestamp, persistentTimestamp);
    assert.throws(
      () => resolveConfig({ tokenFile: malformed }, env()),
      (error) => {
        assert.match(error.message, /empty or malformed/);
        assert.doesNotMatch(error.message, /first-line-token|second-line-secret/);
        return true;
      },
    );
    assert.equal(readFileSync(malformed, 'utf8'), contents, `${label}: persistent malformed file was not replaced`);
  }
});

test('auth: persistence failure is fatal instead of returning an unshared ephemeral token', () => {
  const parentFile = join(tmp, 'not-a-directory');
  writeFileSync(parentFile, 'x', 'utf8');
  assert.throws(
    () => resolveConfig({ tokenFile: join(parentFile, 'bridge.token') }, env()),
    /could not be (read|created exclusively)/,
  );
});

test('auth: generated token file uses POSIX 0600 permissions', { skip: process.platform === 'win32' }, () => {
  const posixToken = join(tmp, 'posix-mode.token');
  resolveConfig({ tokenFile: posixToken }, env());
  assert.equal(statSync(posixToken).mode & 0o777, 0o600);
});

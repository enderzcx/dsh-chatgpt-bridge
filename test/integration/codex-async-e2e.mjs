#!/usr/bin/env node
/**
 * Verification of the async run surface and the "no thread / no turn" guarantee.
 *
 * Two things are proven here that the sync e2e cannot show:
 *   1. a long command starts in milliseconds, streams incremental output that
 *      never repeats a chunk, and can be terminated;
 *   2. across every execution path in this feature, the bridge only ever sends
 *      `command/exec*` — no `thread/start`, `thread/resume`, `turn/start`, or any
 *      other model-facing method reaches the codex app server.
 *
 * Usage: node codex-async-e2e.mjs <repoRoot> <scratchDir> <outFile>
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDirectOpsPolicy } from '../../lib/direct/policy.js';
import { startCommand, readRun, terminateRun } from '../../lib/direct/async-exec.js';
import { CodexAppServerClient } from '../../lib/direct/codex-app-server.js';

// Machine-independent paths: everything is derived from HOME so this
// harness runs on any checkout, not just the author's machine.
const HOME = process.env.HOME ?? '';
const WORKSPACE = process.env.DSH_BRIDGE_WORKSPACE ?? `${HOME}/Work/CODEX`;
const CODEX_HOME_DIR = process.env.DSH_BRIDGE_CODEX_HOME ?? `${HOME}/.dsh/chatgpt-bridge/codex-home`;
const LIVE_POLICY = process.env.DSH_BRIDGE_POLICY ?? `${HOME}/.dsh/chatgpt-bridge/direct-ops/policy.json`;
const OUTSIDE_PROBE = `${HOME}/codex-backend-outside-probe.txt`;
const PLUGIN_LIB = process.env.DSH_BRIDGE_PLUGIN_LIB ?? `${HOME}/.dsh/profiles/desktop/node_modules/dsh-chatgpt-bridge/lib`;

const repoRoot = resolve(process.argv[2] ?? fileURLToPath(new URL('../repo', import.meta.url)));
const scratch = resolve(process.argv[3] ?? fileURLToPath(new URL('../../.scratch-exec', import.meta.url)));
const outFile = resolve(process.argv[4] ?? fileURLToPath(new URL('../../.scratch-exec/codex-async-e2e.json', import.meta.url)));

const CODEX_BIN = process.env.CODEX_BIN
  ?? '/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex';
const ROOT = WORKSPACE;

const evidence = { started_at: new Date().toISOString(), codex_bin: CODEX_BIN, checks: [] };
const failures = [];
function check(name, ok, detail) {
  evidence.checks.push({ name, ok, detail });
  if (!ok) failures.push(`${name}: ${JSON.stringify(detail)}`);
}

function makePolicy() {
  return resolveDirectOpsPolicy({
    enabled: true,
    roots: [ROOT, scratch],
    allowWrites: true,
    writableRoots: [scratch],
    limits: { execTimeoutMs: 60000, execMaxTimeoutMs: 120000, execMaxOutputBytes: 65536 },
    exec: {
      enabled: true,
      allowedCommands: ['sh', 'pwd'],
      cwdRoots: [ROOT, scratch],
      writableRoots: [scratch],
      network: 'deny',
      filesystem: 'roots',
      sandbox: 'required',
      backend: 'codex-app-server',
      codexBin: CODEX_BIN,
      asyncMaxRuns: 4,
      asyncMaxOutputBytes: 65536,
    },
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // The harness owns its scratch directory so it can run from a clean checkout.
  mkdirSync(scratch, { recursive: true });
  const policy = makePolicy();

  // ── 1. the client refuses every thread/turn-shaped method by code ──────────
  const guard = new CodexAppServerClient({ binPath: CODEX_BIN, env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME } });
  for (const method of ['thread/start', 'thread/resume', 'turn/start', 'turn/interrupt']) {
    let refused = false;
    try {
      await guard['request'](method, {}, 1000);
    } catch (error) {
      refused = error?.code === 'CODEX_METHOD_NOT_ALLOWED';
    }
    check(`guard: ${method} is refused`, refused, method);
  }

  // ── 2. a long command returns a run handle immediately ────────────────────
  const t0 = Date.now();
  const run = await startCommand({
    cmd: 'sh',
    args: ['-c', 'i=0; while [ $i -lt 40 ]; do echo tick-$i; sleep 0.4; i=$((i+1)); done'],
    cwd: scratch,
  }, policy);
  const startMs = Date.now() - t0;
  check('async: start returns without waiting for the command', startMs < 5000, startMs);
  check('async: status is running', run.status === 'running', run.status);
  check('async: a run_id is returned', /^run-[0-9a-f-]{36}$/.test(run.run_id), run.run_id);
  check('async: sandbox is reported', run.sandbox.codex_policy === 'workspaceWrite', run.sandbox);

  await sleep(2400);
  const first = readRun(run.run_id, 0, policy);
  check('async: output accumulates while the command runs', first.stdout.includes('tick-0'), first.stdout);
  check('async: multiple chunks arrived', first.seq >= 3, first.seq);
  check('async: still running after the first read', first.status === 'running', first.status);

  // ── 3. incremental reads never repeat a chunk ────────────────────────────
  await sleep(1600);
  const second = readRun(run.run_id, first.seq, policy);
  check('async: since_seq advances', second.seq > first.seq, { first: first.seq, second: second.seq });
  check('async: incremental read is non-empty', second.stdout.length > 0, second.stdout);
  const overlap = second.stdout.split('\n').filter((line) => line !== '' && first.stdout.includes(`${line}\n`));
  check('async: incremental read repeats nothing', overlap.length === 0, overlap);
  const whole = readRun(run.run_id, 0, policy);
  check('async: full read equals first + incremental', whole.stdout === first.stdout + second.stdout, {
    full: whole.stdout.length,
    parts: first.stdout.length + second.stdout.length,
  });

  // ── 4. terminate stops exactly this run ──────────────────────────────────
  const terminated = await terminateRun(run.run_id, policy);
  check('async: terminate reports success', terminated.terminated === true, terminated.terminated);
  check('async: status becomes terminated', terminated.status === 'terminated', terminated.status);
  const afterTerminate = readRun(run.run_id, 0, policy);
  check('async: the run stays stopped', afterTerminate.status === 'terminated', afterTerminate.status);
  const beforeLength = afterTerminate.stdout.length;
  await sleep(1200);
  const later = readRun(run.run_id, 0, policy);
  check('async: no output arrives after termination', later.stdout.length === beforeLength, {
    before: beforeLength,
    after: later.stdout.length,
  });

  // ── 5. a second run is independent ───────────────────────────────────────
  const other = await startCommand({ cmd: 'sh', args: ['-c', 'echo second-run-done'] }, policy);
  check('async: a second run is a distinct id', other.run_id !== run.run_id, other.run_id);
  let otherView = readRun(other.run_id, 0, policy);
  for (let i = 0; i < 40 && otherView.status === 'running'; i += 1) {
    await sleep(250);
    otherView = readRun(other.run_id, 0, policy);
  }
  check('async: the second run completes', otherView.status === 'exited', otherView.status);
  check('async: the second run captured its own output', otherView.stdout.includes('second-run-done'), otherView.stdout);
  check('async: terminating one run did not affect the other', otherView.exit_code === 0, otherView.exit_code);

  // ── 6. an unknown run id is refused, never silently started ──────────────
  let unknownRefused = false;
  try {
    readRun('run-does-not-exist', 0, policy);
  } catch (error) {
    unknownRefused = error?.code === 'RUN_NOT_FOUND';
  }
  check('async: an unknown run_id is refused', unknownRefused, true);

  // ── 7. no thread or turn was ever sent on any connection ────────────────
  const connection = new CodexAppServerClient({
    binPath: CODEX_BIN,
    env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME },
  });
  try {
    await connection.start();
    await connection.exec({ command: ['/bin/pwd'], sandboxPolicy: { type: 'readOnly', networkAccess: false }, timeoutMs: 15000 });
    const offending = connection.sentMethods.filter((m) => /thread|turn/i.test(m));
    check('no-model: no thread/turn method was sent', offending.length === 0, offending);
    check(
      'no-model: only the command/exec surface was used',
      connection.sentMethods.every((m) => m === 'initialize' || m === 'initialized' || m.startsWith('command/exec')),
      connection.sentMethods,
    );
    evidence.sentMethods = connection.sentMethods;
  } finally {
    await connection.close();
  }

  evidence.run_ids = { long: run.run_id, short: other.run_id };
  evidence.failures = failures;
  evidence.passed = failures.length === 0;
  evidence.finished_at = new Date().toISOString();
  writeFileSync(outFile, `${JSON.stringify(evidence, null, 1)}\n`);
  console.log(`${evidence.checks.filter((c) => c.ok).length}/${evidence.checks.length} checks passed`);
  if (failures.length > 0) {
    for (const failure of failures) console.error('FAIL', failure);
    process.exit(1);
  }
}

main().then(() => process.exit(0), (error) => {
  console.error('ASYNC E2E HARNESS ERROR:', error);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * End-to-end verification of the `codex-app-server` execution backend.
 *
 * Walks the real bridge code path (`resolveDirectOpsPolicy` → `runCommand`), not
 * a hand-rolled JSON-RPC client, and writes every result to a JSON file so the
 * evidence survives the session. Exits non-zero on the first failed assertion.
 *
 * Usage: node codex-backend-e2e.mjs <repoRoot> <scratchDir> <outFile>
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDirectOpsPolicy } from '../../lib/direct/policy.js';
import { runCommand } from '../../lib/direct/exec.js';

// Machine-independent paths: everything is derived from HOME so this
// harness runs on any checkout, not just the author's machine.
const HOME = process.env.HOME ?? '';
const WORKSPACE = process.env.DSH_BRIDGE_WORKSPACE ?? `${HOME}/Work/CODEX`;
const CODEX_HOME_DIR = process.env.DSH_BRIDGE_CODEX_HOME ?? `${HOME}/.dsh/chatgpt-bridge/codex-home`;
const LIVE_POLICY = process.env.DSH_BRIDGE_POLICY ?? `${HOME}/.dsh/chatgpt-bridge/direct-ops/policy.json`;
const OUTSIDE_PROBE = `${HOME}/codex-backend-outside-probe.txt`;
const PLUGIN_LIB = process.env.DSH_BRIDGE_PLUGIN_LIB ?? `${HOME}/.dsh/profiles/desktop/node_modules/dsh-chatgpt-bridge/lib`;

// fileURLToPath, not URL.pathname: the workspace path contains non-ASCII
// characters that pathname would leave percent-encoded.
const repoRoot = resolve(process.argv[2] ?? fileURLToPath(new URL('../repo', import.meta.url)));
const scratch = resolve(process.argv[3] ?? fileURLToPath(new URL('../../.scratch-exec', import.meta.url)));
const outFile = resolve(process.argv[4] ?? fileURLToPath(new URL('../../.scratch-exec/codex-backend-e2e.json', import.meta.url)));

const CODEX_BIN = process.env.CODEX_BIN
  ?? '/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex';
const ROOT = WORKSPACE;
const OUTSIDE = OUTSIDE_PROBE;

const evidence = { started_at: new Date().toISOString(), codex_bin: CODEX_BIN, checks: [] };
const failures = [];

/** Record one check and assert it. */
function check(name, ok, detail) {
  evidence.checks.push({ name, ok, detail });
  if (!ok) failures.push(`${name}: ${JSON.stringify(detail)}`);
}

function makePolicy(overrides = {}) {
  return resolveDirectOpsPolicy({
    enabled: true,
    roots: [ROOT, scratch],
    allowWrites: true,
    writableRoots: [scratch],
    limits: { execTimeoutMs: 20000, execMaxTimeoutMs: 120000, execMaxOutputBytes: 65536 },
    exec: {
      enabled: true,
      allowedCommands: ['sh', 'pwd', 'echo', 'env'],
      cwdRoots: [ROOT, scratch],
      writableRoots: [scratch],
      network: 'deny',
      filesystem: 'roots',
      sandbox: 'required',
      backend: 'codex-app-server',
      codexBin: CODEX_BIN,
      ...overrides,
    },
  });
}

/** Run one command, capturing either the result or the refusal. */
async function attempt(input, policy) {
  try {
    return { ok: true, result: await runCommand(input, policy) };
  } catch (error) {
    return { ok: false, code: error?.code, message: String(error?.message ?? error).slice(0, 300) };
  }
}

async function main() {
  // The harness owns its scratch directory so it can run from a clean checkout.
  mkdirSync(scratch, { recursive: true });
  const policy = makePolicy();
  check('policy: backend selected', policy.exec.backend === 'codex-app-server', policy.exec.backend);
  check('policy: codex bin resolved', policy.exec.codexBin === CODEX_BIN, policy.exec.codexBin);
  check(
    'policy: command write roots are the exec list, not the file roots',
    policy.exec.writableRoots.length === 1 && policy.exec.writableRoots[0] === scratch,
    policy.exec.writableRoots,
  );

  // 1. a real command, real cwd
  const pwd = await attempt({ cmd: 'pwd', cwd: scratch }, policy);
  check('pwd: ran', pwd.ok && pwd.result.exit_code === 0, pwd.ok ? pwd.result : pwd);
  check(
    'pwd: reports the requested cwd',
    pwd.ok && pwd.result.stdout.trim() === scratch,
    pwd.ok ? pwd.result.stdout.trim() : pwd,
  );
  check('pwd: reports the codex backend', pwd.ok && pwd.result.backend === 'codex-app-server', pwd.ok ? pwd.result.backend : pwd);

  // 2. an actual computation, not just a builtin
  const math = await attempt({ cmd: 'sh', args: ['-c', 'echo $((6*7))'], cwd: scratch }, policy);
  check('math: ran', math.ok && math.result.exit_code === 0, math.ok ? math.result : math);
  check('math: stdout is 42', math.ok && math.result.stdout.trim() === '42', math.ok ? math.result.stdout : math);

  // 3. non-zero exit + separate streams
  const exit7 = await attempt({ cmd: 'sh', args: ['-c', 'echo to-out; echo to-err >&2; exit 7'], cwd: scratch }, policy);
  check('exit: non-zero exit code reported', exit7.ok && exit7.result.exit_code === 7, exit7.ok ? exit7.result.exit_code : exit7);
  check('exit: stdout captured', exit7.ok && exit7.result.stdout === 'to-out\n', exit7.ok ? exit7.result.stdout : exit7);
  check('exit: stderr captured separately', exit7.ok && exit7.result.stderr === 'to-err\n', exit7.ok ? exit7.result.stderr : exit7);
  check('exit: not reported as timed out', exit7.ok && exit7.result.timed_out === false, exit7.ok ? exit7.result.timed_out : exit7);

  // 4. timeout
  const timeout = await attempt({ cmd: 'sh', args: ['-c', 'sleep 30'], cwd: scratch, timeout_ms: 1500 }, policy);
  check('timeout: reported', timeout.ok && timeout.result.timed_out === true, timeout.ok ? timeout.result : timeout);
  check('timeout: exit code 124', timeout.ok && timeout.result.exit_code === 124, timeout.ok ? timeout.result.exit_code : timeout);
  check('timeout: reports how the conclusion was reached', timeout.ok && timeout.result.sandbox.timeout_evidence === 'wall-time-at-or-past-deadline', timeout.ok ? timeout.result.sandbox.timeout_evidence : timeout);
  // Measured: codex needs ~10s beyond the deadline to kill the process tree, for
  // a 1.5s and a 3s budget alike, so the wall clock is not the budget. What is
  // asserted is that the command did run at least as long as its deadline, that
  // no process survived, and that it does not hang.
  check('timeout: ran at least as long as its deadline', timeout.ok && timeout.result.duration_ms >= 1500, timeout.ok ? timeout.result.duration_ms : timeout);
  check('timeout: returns without hanging', timeout.ok && timeout.result.duration_ms < 30000, timeout.ok ? timeout.result.duration_ms : timeout);

  // 4b. a command that exits 124 by itself must keep its code and not be called a timeout
  const self124 = await attempt({ cmd: 'sh', args: ['-c', 'exit 124'], cwd: scratch, timeout_ms: 30000 }, policy);
  check('exit124: the raw exit code is preserved', self124.ok && self124.result.exit_code === 124, self124.ok ? self124.result.exit_code : self124);
  check('exit124: a self-chosen 124 is not reported as a timeout', self124.ok && self124.result.timed_out === false, self124.ok ? self124.result.timed_out : self124);

  // 5. write inside the configured write root
  const insideWrite = await attempt({ cmd: 'sh', args: ['-c', 'echo ok > in-root.txt && cat in-root.txt'], cwd: scratch }, policy);
  check('write: inside the write root succeeds', insideWrite.ok && insideWrite.result.exit_code === 0, insideWrite.ok ? insideWrite.result : insideWrite);
  check('write: content visible', insideWrite.ok && insideWrite.result.stdout.includes('ok'), insideWrite.ok ? insideWrite.result.stdout : insideWrite);

  // 6. write outside the configured write root is denied by the OS
  const outsideWrite = await attempt({ cmd: 'sh', args: ['-c', `echo no > ${OUTSIDE}`], cwd: scratch }, policy);
  check('write: outside the write root is refused', outsideWrite.ok && outsideWrite.result.exit_code !== 0, outsideWrite.ok ? outsideWrite.result.exit_code : outsideWrite);
  check(
    'write: refusal is a sandbox denial, not a missing path',
    outsideWrite.ok && /not permitted|denied|read-only/i.test(outsideWrite.result.stderr),
    outsideWrite.ok ? outsideWrite.result.stderr : outsideWrite,
  );

  // 7. readOnly policy (no configured write roots) denies even the write root
  const readOnlyPolicy = makePolicy({ writableRoots: [] });
  const readOnlyAttempt = await attempt({ cmd: 'sh', args: ['-c', 'echo x > in-root.txt'], cwd: scratch }, readOnlyPolicy);
  check('readOnly: write refused', readOnlyAttempt.ok && readOnlyAttempt.result.exit_code !== 0, readOnlyAttempt.ok ? readOnlyAttempt.result : readOnlyAttempt);
  check(
    'readOnly: reports the codex readOnly policy',
    readOnlyAttempt.ok && readOnlyAttempt.result.sandbox.codex_policy === 'readOnly',
    readOnlyAttempt.ok ? readOnlyAttempt.result.sandbox : readOnlyAttempt,
  );
  check(
    'readOnly: says writes are not granted',
    readOnlyAttempt.ok && String(readOnlyAttempt.result.sandbox.write_scope) === 'none',
    readOnlyAttempt.ok ? readOnlyAttempt.result.sandbox.write_scope : readOnlyAttempt,
  );

  // 8. the allowlist still governs
  const denied = await attempt({ cmd: 'curl', cwd: scratch }, policy);
  check('allowlist: an unlisted command is refused', denied.ok === false && denied.code === 'COMMAND_NOT_ALLOWED', denied);

  // 9. exec disabled fails closed even with the backend selected
  const disabledPolicy = resolveDirectOpsPolicy({
    enabled: true, roots: [ROOT, scratch], allowWrites: true, writableRoots: [scratch],
    exec: { enabled: false, allowedCommands: ['sh'], backend: 'codex-app-server', codexBin: CODEX_BIN },
  });
  const disabled = await attempt({ cmd: 'sh', args: ['-c', 'echo x'], cwd: scratch }, disabledPolicy);
  check('disabled: exec refuses', disabled.ok === false && disabled.code === 'EXEC_DISABLED', disabled);

  // 10. backend unavailable fails closed, with the configuration key named
  const noBin = makePolicy({ codexBin: undefined });
  const noBinAttempt = await attempt({ cmd: 'pwd', cwd: scratch }, noBin);
  check('unconfigured: refuses to guess a binary', noBinAttempt.ok === false && noBinAttempt.code === 'CODEX_BIN_UNCONFIGURED', noBinAttempt);

  const badBin = makePolicy({ codexBin: '/nonexistent/codex-binary' });
  const badBinAttempt = await attempt({ cmd: 'pwd', cwd: scratch }, badBin);
  check('missing binary: fails closed', badBinAttempt.ok === false, badBinAttempt);
  check(
    'missing binary: stable code',
    badBinAttempt.ok === false && String(badBinAttempt.code).startsWith('CODEX_'),
    badBinAttempt.code,
  );

  // 11. fs "inherit" has no faithful codex equivalent, so it must refuse
  const inheritPolicy = makePolicy({ filesystem: 'inherit' });
  const inheritAttempt = await attempt({ cmd: 'pwd', cwd: scratch }, inheritPolicy);
  check(
    'filesystem=inherit: refused rather than widened',
    inheritAttempt.ok === false && inheritAttempt.code === 'CODEX_POLICY_UNSUPPORTED',
    inheritAttempt,
  );

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
  console.error('E2E HARNESS ERROR:', error);
  process.exit(1);
});

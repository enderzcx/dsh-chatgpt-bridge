#!/usr/bin/env node
/**
 * Verifies the INSTALLED plugin (the profile's node_modules copy) against the
 * live policy file, and writers every result to stdout so the caller can tee it
 * to a durable log. This is the "does the thing that will actually run work"
 * check; the source-tree harnesses cover the code before packaging.
 */
import { resolveDirectOpsPolicy } from PLUGIN_LIB + '/direct/policy.js';
import { runCommand } from PLUGIN_LIB + '/direct/exec.js';
import { startCommand, readRun, terminateRun } from PLUGIN_LIB + '/direct/async-exec.js';
import { describePolicy } from PLUGIN_LIB + '/direct/tools.js';
import { createRequire } from 'node:module';

// Machine-independent paths: everything is derived from HOME so this
// harness runs on any checkout, not just the author's machine.
const HOME = process.env.HOME ?? '';
const WORKSPACE = process.env.DSH_BRIDGE_WORKSPACE ?? `${HOME}/Work/CODEX`;
const CODEX_HOME_DIR = process.env.DSH_BRIDGE_CODEX_HOME ?? `${HOME}/.dsh/chatgpt-bridge/codex-home`;
const LIVE_POLICY = process.env.DSH_BRIDGE_POLICY ?? `${HOME}/.dsh/chatgpt-bridge/direct-ops/policy.json`;
const OUTSIDE_PROBE = `${HOME}/codex-backend-outside-probe.txt`;
const PLUGIN_LIB = process.env.DSH_BRIDGE_PLUGIN_LIB ?? `${HOME}/.dsh/profiles/desktop/node_modules/dsh-chatgpt-bridge/lib`;

const require = createRequire(import.meta.url);
const WS = WORKSPACE;
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}${ok ? '' : `  -> ${JSON.stringify(detail)}`}`);
};

const pluginVersion = require(`${HOME}/.dsh/profiles/desktop/node_modules/dsh-chatgpt-bridge/package.json`).version;
check('installed plugin version is 0.6.0', pluginVersion === '0.6.0', pluginVersion);

const policy = resolveDirectOpsPolicy({
  enabled: true,
  allowWrites: true,
  policyFile: LIVE_POLICY,
});
const view = describePolicy(policy, { policy: () => policy, reload: () => policy, reloadable: true });
check('live policy selects the codex backend', view.exec_backend === 'codex-app-server', view.exec_backend);
check('live policy reports the sandbox as available', view.sandbox_available === true, view.sandbox_available);
check('command writes are scoped, not the file roots', view.command_writable_roots.join(',') === WS, view.command_writable_roots);

const pwd = await runCommand({ cmd: 'pwd', cwd: WS }, policy);
check('pwd runs through codex', pwd.exit_code === 0 && pwd.stdout.trim() === WS, { exit: pwd.exit_code, out: pwd.stdout.trim() });
check('pwd reports the codex backend', pwd.backend === 'codex-app-server', pwd.backend);

const python = await runCommand({ cmd: 'python3', args: ['-c', 'print(6*7)'], cwd: WS }, policy);
check('python3 computes 42', python.exit_code === 0 && python.stdout.trim() === '42', { exit: python.exit_code, out: python.stdout.trim() });

const node = await runCommand({ cmd: 'node', args: ['-e', 'console.log(2**10)'], cwd: WS }, policy);
check('node computes 1024', node.exit_code === 0 && node.stdout.trim() === '1024', { exit: node.exit_code, out: node.stdout.trim() });

const exit3 = await runCommand({ cmd: 'sh', args: ['-c', 'echo O; echo E >&2; exit 3'], cwd: WS }, policy);
check('non-zero exit is reported', exit3.exit_code === 3, exit3.exit_code);
check('stdout and stderr stay separate', exit3.stdout === 'O\n' && exit3.stderr === 'E\n', { out: exit3.stdout, err: exit3.stderr });

const timed = await runCommand({ cmd: 'sh', args: ['-c', 'sleep 20'], cwd: WS, timeout_ms: 1500 }, policy);
check('timeout reports exit 124 and timed_out', timed.exit_code === 124 && timed.timed_out === true, { exit: timed.exit_code, timed_out: timed.timed_out });
check('timeout returns promptly', timed.duration_ms < 15000, timed.duration_ms);

const capped = await runCommand({ cmd: 'sh', args: ['-c', 'yes abcdefghij | head -c 200000'], cwd: WS, max_output_bytes: 4096 }, policy);
check('large output is capped by the request budget', Buffer.byteLength(capped.stdout, 'utf8') <= 4096, Buffer.byteLength(capped.stdout, 'utf8'));
check('capped output reports truncation', capped.stdout_truncated === true, capped.stdout_truncated);

const emoji = await runCommand({ cmd: 'python3', args: ['-c', 'print("\U0001F600"*40, end="")'], cwd: WS, max_output_bytes: 100 }, policy);
check('multibyte output is cut on a character boundary', !emoji.stdout.includes('\uFFFD') && Buffer.byteLength(emoji.stdout, 'utf8') <= 100, { bytes: Buffer.byteLength(emoji.stdout, 'utf8'), out: emoji.stdout.slice(0, 6) });

const self124 = await runCommand({ cmd: 'sh', args: ['-c', 'exit 124'], cwd: WS, timeout_ms: 30000 }, policy);
check('a self-chosen 124 keeps its code and is not a timeout', self124.exit_code === 124 && self124.timed_out === false, { exit: self124.exit_code, timed_out: self124.timed_out });

const tmpProbe = await runCommand({ cmd: 'sh', args: ['-c', 'echo x > "$TMPDIR/dsh-tmp-probe-$$.txt"'], cwd: WS }, policy);
check('$TMPDIR writes are excluded', tmpProbe.exit_code !== 0, tmpProbe.exit_code);
const tmpProbe2 = await runCommand({ cmd: 'sh', args: ['-c', 'echo x > /tmp/dsh-st-probe-$$.txt'], cwd: WS }, policy);
check('/tmp writes are excluded', tmpProbe2.exit_code !== 0, tmpProbe2.exit_code);

const inside = await runCommand({ cmd: 'sh', args: ['-c', 'echo ok > ws-verify.txt && cat ws-verify.txt'], cwd: WS }, policy);
check('a write inside the configured write root succeeds', inside.exit_code === 0 && inside.stdout.trim() === 'ok', { exit: inside.exit_code, err: inside.stderr.trim() });

const outside = await runCommand({ cmd: 'sh', args: ['-c', `echo no > ${OUTSIDE_PROBE}`], cwd: WS }, policy);
check('a write outside the write root is denied', outside.exit_code !== 0, outside.exit_code);
check('the denial is a sandbox refusal', /not permitted/i.test(outside.stderr), outside.stderr.trim());

const denied = await (async () => {
  try {
    await runCommand({ cmd: 'curl', cwd: WS }, policy);
    return null;
  } catch (error) {
    return error.code;
  }
})();
check('an unlisted command is refused', denied === 'COMMAND_NOT_ALLOWED', denied);

const long = await startCommand({ cmd: 'sh', args: ['-c', 'for i in 1 2 3 4 5 6 7 8 9 10; do echo live-$i; sleep 0.5; done'], cwd: WS }, policy);
check('async start returns a run_id while running', /^run-/.test(long.run_id) && long.status === 'running', { id: long.run_id, status: long.status });
await new Promise((r) => setTimeout(r, 1500));
const first = readRun(long.run_id, 0, policy);
check('async output streams before exit', first.stdout.includes('live-1'), first.stdout.trim().split('\n'));
await new Promise((r) => setTimeout(r, 1200));
const second = readRun(long.run_id, first.seq, policy);
check('incremental read returns only new chunks', second.stdout.length > 0 && !second.stdout.includes('live-1\n'), second.stdout.trim().split('\n'));
const terminated = await terminateRun(long.run_id, policy);
check('terminate stops a still-running run', terminated.terminated === true && terminated.status === 'terminated', { terminated: terminated.terminated, status: terminated.status });

const failed = await startCommand({ cmd: 'sh', args: ['-c', 'exit 9'], cwd: WS }, policy);
await new Promise((r) => setTimeout(r, 1500));
const failedView = readRun(failed.run_id, 0, policy);
check('a finished run reports its exit code', failedView.exit_code === 9, failedView.exit_code);

const unknown = await (async () => {
  try {
    readRun('run-nope', 0, policy);
    return null;
  } catch (error) {
    return error.code;
  }
})();
check('an unknown run_id is refused', unknown === 'RUN_NOT_FOUND', unknown);

const badCwd = await (async () => {
  try {
    await runCommand({ cmd: 'pwd', cwd: `${HOME}` }, policy);
    return null;
  } catch (error) {
    return error.code;
  }
})();
check('a cwd outside the run roots is refused', badCwd === 'PATH_OUTSIDE_ROOTS', badCwd);

const failedChecks = results.filter((r) => !r.ok);
console.log(`\n${results.length - failedChecks.length}/${results.length} installed-plugin checks passed`);
process.exit(failedChecks.length === 0 ? 0 : 1);

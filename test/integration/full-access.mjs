#!/usr/bin/env node
/**
 * Administrator full-access mode: what it enables, and what it still refuses.
 *
 * Runs through the real bridge exec path with `exec.fullAccess: true`, then the
 * same calls with the default (false) policy to show the default restriction is
 * unchanged.
 */
import { resolveDirectOpsPolicy } from '../../lib/direct/policy.js';
import { runCommand } from '../../lib/direct/exec.js';
import { startCommand, readRun } from '../../lib/direct/async-exec.js';
import { describePolicy } from '../../lib/direct/tools.js';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Machine-independent paths: everything is derived from HOME so this
// harness runs on any checkout, not just the author's machine.
const HOME = process.env.HOME ?? '';
const WORKSPACE = process.env.DSH_BRIDGE_WORKSPACE ?? `${HOME}/Work/CODEX`;
const CODEX_HOME_DIR = process.env.DSH_BRIDGE_CODEX_HOME ?? `${HOME}/.dsh/chatgpt-bridge/codex-home`;
const LIVE_POLICY = process.env.DSH_BRIDGE_POLICY ?? `${HOME}/.dsh/chatgpt-bridge/direct-ops/policy.json`;
const OUTSIDE_PROBE = `${HOME}/codex-backend-outside-probe.txt`;
const PLUGIN_LIB = process.env.DSH_BRIDGE_PLUGIN_LIB ?? `${HOME}/.dsh/profiles/desktop/node_modules/dsh-chatgpt-bridge/lib`;

const CODEX = '/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex';
const LARK = '/opt/homebrew/bin/lark-cli';
let fail = 0;
const check = (n, ok, d) => { console.log(`${ok ? 'OK  ' : 'FAIL'}  ${n}${ok ? '' : `  -> ${JSON.stringify(d)}`}`); if (!ok) fail += 1; };

const base = {
  // Mirrors the live policy shape: `/` plus the task subroot, both writable.
  enabled: true, roots: ['/', WORKSPACE], allowWrites: true,
  writableRoots: ['/', WORKSPACE],
  limits: { execTimeoutMs: 60000, execMaxTimeoutMs: 300000, execMaxOutputBytes: 200000 },
  exec: {
    enabled: true, allowedCommands: ['sh', 'pwd'], cwdRoots: [WORKSPACE],
    writableRoots: [WORKSPACE], network: 'deny', filesystem: 'roots', sandbox: 'required',
    backend: 'codex-app-server', codexBin: CODEX, codexHome: CODEX_HOME_DIR,
    pathEntries: ['/opt/homebrew/bin'],
  },
};
const restricted = resolveDirectOpsPolicy(base);
const full = resolveDirectOpsPolicy({ ...base, exec: { ...base.exec, fullAccess: true } });

const attempt = async (input, policy) => {
  try { return { ok: true, r: await runCommand(input, policy) }; }
  catch (e) { return { ok: false, code: e?.code, message: String(e?.message).slice(0, 120) }; }
};

// 1. default policy is unchanged: the old restrictions still bite
const d1 = await attempt({ cmd: 'lark-cli', args: ['--version'], cwd: WORKSPACE }, restricted);
check('default policy still refuses a non-allowlisted command', d1.ok === false && d1.code === 'COMMAND_NOT_ALLOWED', d1);
const d2 = await attempt({ cmd: 'pwd', cwd: '/tmp' }, restricted);
check('default policy still refuses a cwd outside cwdRoots', d2.ok === false && d2.code === 'PATH_OUTSIDE_ROOTS', d2);
const d3 = await attempt({ cmd: 'pwd', cwd: '/etc' }, restricted);
check('default policy still refuses cwd=/etc', d3.ok === false && d3.code === 'PATH_OUTSIDE_ROOTS', d3);
// With cwdRoots configured, omitting cwd legitimately defaults to the first root.
const d4 = await attempt({ cmd: 'pwd' }, restricted);
check('default policy still allows its configured cwd root', d4.ok === true, d4.code);

// 2. full access: arbitrary bare-name executable
const f1 = await attempt({ cmd: 'lark-cli', args: ['--version'], cwd: '/tmp' }, full);
check('full access runs lark-cli by bare name from a non-CODEX cwd', f1.ok && f1.r.exit_code === 0, f1.ok ? f1.r : f1);
check('lark-cli reports its version', f1.ok && /1\.0\.96|version/i.test(f1.r.stdout), f1.ok ? f1.r.stdout : f1);

// 3. full access: cwd outside CODEX, and it really is that directory
const f2 = await attempt({ cmd: 'pwd', cwd: '/tmp' }, full);
check('full access allows a cwd outside the old roots', f2.ok && f2.r.exit_code === 0, f2.ok ? f2.r : f2);
check('the command really ran in that cwd', f2.ok && f2.r.stdout.trim().replace('/private', '') === '/tmp', f2.ok ? f2.r.stdout : f2);

// 4. full access: write in a fresh directory outside the old write roots, then clean up
const scratch = mkdtempSync(join(tmpdir(), 'full-access-'));
const probe = join(scratch, 'probe.txt');
const f3 = await attempt({ cmd: 'sh', args: ['-c', `echo written > ${probe} && cat ${probe}`], cwd: scratch }, full);
check('full access writes outside the old write roots', f3.ok && f3.r.exit_code === 0 && f3.r.stdout.includes('written'), f3.ok ? f3.r : f3);
rmSync(scratch, { recursive: true, force: true });
check('the test file was cleaned up', !existsSync(probe), probe);

// 5. full access: network reaches the outside world
const f4 = await attempt({ cmd: 'curl', args: ['-sS', '-o', '/dev/null', '-w', '%{http_code}', 'https://open.feishu.cn/'], cwd: '/tmp' }, full);
// Any HTTP status proves the request reached the internet and returned; this
// host answers 404 at `/` but that is still a completed round trip.
check('full access can reach the network', f4.ok && f4.r.exit_code === 0 && /^[1-5][0-9]{2}$/.test(f4.r.stdout.trim()), f4.ok ? { code: f4.r.exit_code, out: f4.r.stdout } : f4);

// 6. honesty: the result and the policy view say there is no sandbox
check('the result reports applied=false (no OS sandbox)', f1.ok && f1.r.sandbox.applied === false, f1.ok ? f1.r.sandbox : f1);
check('the result names dangerFullAccess', f1.ok && f1.r.sandbox.codex_policy === 'dangerFullAccess', f1.ok ? f1.r.sandbox.codex_policy : f1);
check('the result no longer claims sandboxed write scope', f1.ok && /unconfined/i.test(String(f1.r.sandbox.write_scope)), f1.ok ? f1.r.sandbox.write_scope : f1);
// The configured network is deny; the child is online. The result must not
// report the configured value as if it were in force.
check('result network is unconfined, not the configured deny', f1.ok && f1.r.sandbox.network === 'unconfined', f1.ok ? f1.r.sandbox.network : f1);
check('result filesystem is unconfined, not the configured roots', f1.ok && f1.r.sandbox.filesystem === 'unconfined', f1.ok ? f1.r.sandbox.filesystem : f1);
check('the configured values are reported separately', f1.ok && f1.r.sandbox.configured_network === 'deny' && f1.r.sandbox.configured_filesystem === 'roots', f1.ok ? f1.r.sandbox : f1);
check('result states cwd and commands are unrestricted', f1.ok && f1.r.sandbox.cwd_restricted === false && f1.r.sandbox.command_restricted === false, f1.ok ? f1.r.sandbox : f1);
check('result sandbox kind is none when unconfined', f1.ok && f1.r.sandbox.kind === 'none', f1.ok ? f1.r.sandbox.kind : f1);
// And the restricted path still reports the configured boundary as effective.
const rp = await attempt({ cmd: 'pwd', cwd: WORKSPACE }, restricted);
check('restricted result still reports network=deny as effective', rp.ok && rp.r.sandbox.network === 'deny', rp.ok ? rp.r.sandbox.network : rp);
check('restricted result still reports filesystem=roots as effective', rp.ok && rp.r.sandbox.filesystem === 'roots', rp.ok ? rp.r.sandbox.filesystem : rp);
check('restricted result reports applied=true', rp.ok && rp.r.sandbox.applied === true, rp.ok ? rp.r.sandbox.applied : rp);
const view = describePolicy(full, { policy: () => full, reload: () => full, reloadable: true });
check('the policy view reports full_access=true', view.full_access === true, view.full_access);
check('the policy view states there is no sandbox', view.notes.some((n) => /NO OS sandbox|no OS sandbox/i.test(n)), view.notes);
const rview = describePolicy(restricted, { policy: () => restricted, reload: () => restricted, reloadable: true });
check('the default policy view reports full_access=false', rview.full_access === false, rview.full_access);
// The view must not echo the configured deny/roots as the effective boundary.
check('view network is unconfined under full access', view.network === 'unconfined', view.network);
check('view filesystem is unconfined under full access', view.filesystem === 'unconfined', view.filesystem);
check('view reports the configured values separately', view.configured_network === 'deny' && view.configured_filesystem === 'roots', { n: view.configured_network, f: view.configured_filesystem });
check('view command_writable_roots is unconfined', view.command_writable_roots === 'unconfined', view.command_writable_roots);
check('view sandbox_kind is none under full access', view.sandbox_kind === 'none', view.sandbox_kind);
check('restricted view still reports network=deny', rview.network === 'deny', rview.network);
check('restricted view still reports filesystem=roots', rview.filesystem === 'roots', rview.filesystem);
check('restricted view has no configured_* mirror', rview.configured_network === undefined, rview.configured_network);
// The general exec note must not claim a boundary that full access removed.
check('no note claims trusted-root enforcement under full access',
  !view.notes.some((n) => /trusted-root list is enforced/i.test(n)), view.notes);
check('a note states the allowlist and cwd limits do not apply',
  view.notes.some((n) => /no command allowlist/i.test(n) && /no cwd-root confinement/i.test(n)), view.notes);
check('view reports command_policy=any-on-path', view.command_policy === 'any-on-path', view.command_policy);
check('view reports the configured allowlist separately', Array.isArray(view.configured_allowed_commands) && view.configured_allowed_commands.length > 0, view.configured_allowed_commands);
check('view reports exec_sandbox_effective=none', view.exec_sandbox_effective === 'none', view.exec_sandbox_effective);
check('view still reports the configured exec_sandbox', view.exec_sandbox === 'required', view.exec_sandbox);
// The restricted view keeps the old note and the allowlist policy.
check('restricted view still says the trusted-root list is enforced',
  rview.notes.some((n) => /trusted-root list is enforced/i.test(n)), rview.notes);
check('restricted view reports command_policy=allowlist', rview.command_policy === 'allowlist', rview.command_policy);
check('restricted view reports exec_sandbox_effective=required', rview.exec_sandbox_effective === 'required', rview.exec_sandbox_effective);

// 7. still not root
const f5 = await attempt({ cmd: 'id', args: ['-u'], cwd: '/tmp' }, full);
check('commands run as the login user, not root', f5.ok && f5.r.stdout.trim() !== '0', f5.ok ? f5.r.stdout.trim() : f5);

// 8. async path behaves the same
const run = await startCommand({ cmd: 'lark-cli', args: ['--version'], cwd: '/tmp' }, full);
let v = readRun(run.run_id, 0, full);
for (let i = 0; i < 60 && v.status === 'running'; i += 1) { await new Promise((r) => setTimeout(r, 250)); v = readRun(run.run_id, 0, full); }
check('async path also runs lark-cli', v.status === 'exited' && v.exit_code === 0, { status: v.status, exit: v.exit_code, err: v.error });
// Assert the SAME effective fields the sync path publishes, not a string search.
check('async path reports applied=false', v.sandbox.applied === false, v.sandbox);
check('async path reports network=unconfined', v.sandbox.network === 'unconfined', v.sandbox.network);
check('async path reports filesystem=unconfined', v.sandbox.filesystem === 'unconfined', v.sandbox.filesystem);
check('async path reports the configured values separately', v.sandbox.configured_network === 'deny' && v.sandbox.configured_filesystem === 'roots', v.sandbox);
check('async path reports dangerFullAccess', v.sandbox.codex_policy === 'dangerFullAccess', v.sandbox.codex_policy);
check('async path reports cwd/command unrestricted', v.sandbox.cwd_restricted === false && v.sandbox.command_restricted === false, v.sandbox);

// 9. no thread/turn: the adapter only ever sends command/exec.
const { CodexAppServerClient } = await import('../../lib/direct/codex-app-server.js');
const noModel = new CodexAppServerClient({ binPath: CODEX, env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, CODEX_HOME: CODEX_HOME_DIR } });
await noModel.start();
await noModel.exec({ command: ['/bin/pwd'], sandboxPolicy: { type: 'dangerFullAccess' }, timeoutMs: 15000, cwd: '/tmp' });
const offending = noModel.sentMethods.filter((m) => /thread|turn/i.test(m));
check('no thread/turn method was sent in full-access mode', offending.length === 0, offending);
check('only the command/exec surface was used', noModel.sentMethods.every((m) => m === 'initialize' || m === 'initialized' || m.startsWith('command/exec')), noModel.sentMethods);
await noModel.close();

void execSync; void writeFileSync; void LARK;
console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILURES'}`);
process.exit(fail === 0 ? 0 : 1);

import { execSync } from 'node:child_process';
import { resolveDirectOpsPolicy } from '../../lib/direct/policy.js';
import { startCommand, readRun, terminateRun } from '../../lib/direct/async-exec.js';

// Machine-independent paths: everything is derived from HOME so this
// harness runs on any checkout, not just the author's machine.
const HOME = process.env.HOME ?? '';
const WORKSPACE = process.env.DSH_BRIDGE_WORKSPACE ?? `${HOME}/Work/CODEX`;
const CODEX_HOME_DIR = process.env.DSH_BRIDGE_CODEX_HOME ?? `${HOME}/.dsh/chatgpt-bridge/codex-home`;
const LIVE_POLICY = process.env.DSH_BRIDGE_POLICY ?? `${HOME}/.dsh/chatgpt-bridge/direct-ops/policy.json`;
const OUTSIDE_PROBE = `${HOME}/codex-backend-outside-probe.txt`;
const PLUGIN_LIB = process.env.DSH_BRIDGE_PLUGIN_LIB ?? `${HOME}/.dsh/profiles/desktop/node_modules/dsh-chatgpt-bridge/lib`;
const policy = resolveDirectOpsPolicy({ enabled:true, allowWrites:true, policyFile:LIVE_POLICY });
const WS = WORKSPACE;
let fail = 0;
const ok = (n,c,d)=>{ console.log(`${c?'OK  ':'FAIL'} ${n}${c?'':'  '+JSON.stringify(d)}`); if(!c) fail++; };
const tag = `term-scope-${Date.now()}`;
const count = (t) => { try { return Number(execSync(`pgrep -f "${t}" | wc -l`, {encoding:'utf8'}).trim()); } catch { return 0; } };

// Two independent runs; terminate one and prove the other is untouched.
const a = await startCommand({ cmd:'node', args:['-e',`const t=Date.now(); while(Date.now()-t<60000){} console.log("${tag}-A")`], cwd:WS }, policy);
const b = await startCommand({ cmd:'node', args:['-e',`const t=Date.now(); while(Date.now()-t<60000){} console.log("${tag}-B")`], cwd:WS }, policy);
await new Promise(r=>setTimeout(r,1500));
ok('both runs are alive before terminating one', count(tag) === 2, count(tag));

const t = await terminateRun(a.run_id, policy);
ok('terminate reports success for its own run only', t.terminated === true && t.confirmation === 'exited', { terminated: t.terminated, confirmation: t.confirmation });
await new Promise(r=>setTimeout(r,1200));
ok('exactly one process remains (the other run is untouched)', count(tag) === 1, count(tag));

const bView = readRun(b.run_id, 0, policy);
ok('the untouched run is still running', bView.status === 'running', bView.status);

const t2 = await terminateRun(b.run_id, policy);
ok('the second run can be terminated independently', t2.terminated === true, t2.terminated);
await new Promise(r=>setTimeout(r,1200));
ok('no leftover processes', count(tag) === 0, count(tag));

// Clean up: nothing of ours may remain.
try { execSync(`pkill -f "${tag}"`, {stdio:'ignore'}); } catch {}
console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILURES'}`);
process.exit(fail ? 1 : 0);

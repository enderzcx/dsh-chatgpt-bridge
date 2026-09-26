import { resolveDirectOpsPolicy } from '../../lib/direct/policy.js';
import { runCommand } from '../../lib/direct/exec.js';
import { startCommand, readRun } from '../../lib/direct/async-exec.js';

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
const ok = (n, c, d) => { console.log(`${c?'OK  ':'FAIL'} ${n}${c?'':'  '+JSON.stringify(d)}`); if(!c) fail++; };

// 1. THE reported bug: a 12s task with timeout_ms=25000 must run to completion,
//    not be cut at ~10s by a server default that never received the timeout.
const t0 = Date.now();
const r = await runCommand({ cmd:'node', args:['-e','const t=Date.now(); while(Date.now()-t<12000){} console.log("worked"); process.exit(7)'], cwd:WS, timeout_ms:25000 }, policy);
const elapsed = Date.now() - t0;
ok('12s task with timeout_ms=25000 completes (exit 7, not 124)', r.exit_code === 7, { exit: r.exit_code, timed_out: r.timed_out, elapsed });
ok('it really ran ~12s, past the old ~10s cutoff', elapsed >= 11500, elapsed);
ok('stdout is delivered in full', r.stdout.includes('worked'), r.stdout);
ok('not reported as timed out', r.timed_out === false, r.timed_out);

// 2. A short timeout must actually be transmitted and enforced.
const s0 = Date.now();
const short = await runCommand({ cmd:'node', args:['-e','const t=Date.now(); while(Date.now()-t<20000){}'], cwd:WS, timeout_ms:3000 }, policy);
ok('short timeout_ms=3000 is enforced (exit 124)', short.exit_code === 124 && short.timed_out === true, { exit: short.exit_code, timed_out: short.timed_out, ms: Date.now()-s0 });

// 3. A command exiting 124 by itself is not a timeout (regression guard).
const self = await runCommand({ cmd:'node', args:['-e','process.exit(124)'], cwd:WS, timeout_ms:30000 }, policy);
ok('self-chosen exit 124 keeps its code and is not a timeout', self.exit_code === 124 && self.timed_out === false, { exit: self.exit_code, timed_out: self.timed_out });

// 4. Streaming must not replay the final cumulative result.
const run = await startCommand({ cmd:'node', args:['-e','for(let i=1;i<=4;i++){console.log("line-"+i); }'], cwd:WS }, policy);
let v = readRun(run.run_id, 0, policy);
for (let i=0;i<40 && v.status==='running';i++){ await new Promise(x=>setTimeout(x,250)); v = readRun(run.run_id, 0, policy); }
const lines = v.stdout.trim().split('\n');
ok('streamed output is not duplicated by the final result', lines.length === 4, lines);
ok('the seq cursor sees no late replay', v.stdout === 'line-1\nline-2\nline-3\nline-4\n', JSON.stringify(v.stdout));
const after = readRun(run.run_id, v.seq, policy);
ok('a since_seq read after exit returns nothing new', after.stdout === '' && after.stderr === '', { out: after.stdout, err: after.stderr });

// 5. Legitimate repeated identical text must survive (no text de-duplication).
const dup = await startCommand({ cmd:'node', args:['-e','console.log("same"); console.log("same"); console.log("same");'], cwd:WS }, policy);
let d = readRun(dup.run_id, 0, policy);
for (let i=0;i<40 && d.status==='running';i++){ await new Promise(x=>setTimeout(x,250)); d = readRun(dup.run_id, 0, policy); }
ok('repeated identical lines are preserved, not deduplicated', d.stdout === 'same\nsame\nsame\n', JSON.stringify(d.stdout));

// 6. Per-stream fallback: stderr must still arrive when only stdout streamed.
const mix = await startCommand({ cmd:'node', args:['-e','process.stdout.write("out-only\\n"); process.stderr.write("err-only\\n");'], cwd:WS }, policy);
let m = readRun(mix.run_id, 0, policy);
for (let i=0;i<40 && m.status==='running';i++){ await new Promise(x=>setTimeout(x,250)); m = readRun(mix.run_id, 0, policy); }
ok('stdout and stderr both present exactly once', m.stdout === 'out-only\n' && m.stderr === 'err-only\n', { out: m.stdout, err: m.stderr });

// 7. UTF-8 split across chunks must survive streaming.
const emoji = await startCommand({ cmd:'node', args:['-e','for(const c of "😀😀😀😀😀😀"){process.stdout.write(c); }'], cwd:WS }, policy);
let e2 = readRun(emoji.run_id, 0, policy);
for (let i=0;i<40 && e2.status==='running';i++){ await new Promise(x=>setTimeout(x,250)); e2 = readRun(emoji.run_id, 0, policy); }
ok('emoji streamed without corruption', e2.stdout === '😀😀😀😀😀😀' && !e2.stdout.includes('\uFFFD'), JSON.stringify(e2.stdout));
console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILURES'}`);
process.exit(fail ? 1 : 0);

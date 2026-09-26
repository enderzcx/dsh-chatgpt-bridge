/**
 * Does codex workspaceWrite grant writes beyond writableRoots?
 * Direct protocol probe: configured writableRoots=[A], cwd=B (a different dir).
 * Tests: write into B (the cwd), into $TMPDIR, into /tmp, and into A.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const BIN = '/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex';
const A = process.argv[2];
const B = process.argv[3];
const TMP = process.env.TMPDIR ?? '/tmp';

const child = spawn(BIN, ['app-server', '--listen', 'stdio://'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? '' },
});
const rl = createInterface({ input: child.stdout });
let id = 0;
const pending = new Map();
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
});
const call = (method, params) => {
  const myId = ++id;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, params })}\n`);
  return new Promise((res, rej) => { pending.set(myId, { resolve: res, reject: rej }); setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error('timeout')); } }, 60000); });
};
await call('initialize', { clientInfo: { name: 'leak-probe', version: '1' }, capabilities: { experimentalApi: true } });
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);

const run = async (label, script, policy) => {
  try {
    const r = await call('command/exec', { command: ['/bin/sh', '-c', script], cwd: B, sandboxPolicy: policy, timeoutMs: 20000 });
    console.log(`${label.padEnd(38)} exit=${String(r.exitCode).padStart(3)}  ${r.exitCode === 0 ? 'ALLOWED' : 'DENIED '}  ${(r.stderr || '').trim().slice(0, 80)}`);
    return r.exitCode === 0;
  } catch (e) { console.log(`${label.padEnd(38)} RPC-ERROR ${String(e.message).slice(0, 70)}`); return null; }
};

const base = { type: 'workspaceWrite', writableRoots: [A], networkAccess: false };
console.log(`A (configured writableRoot) = ${A}`);
console.log(`B (cwd, NOT a writableRoot) = ${B}`);
console.log(`TMPDIR                      = ${TMP}`);
console.log('');
console.log('--- default workspaceWrite (no exclude flags) ---');
const bWrite = await run('write into cwd B', `echo x > ${B}/b.txt`, base);
const tmpWrite = await run('write into $TMPDIR', `echo x > ${TMP}/leak-tmp-$$.txt`, base);
const slashTmp = await run('write into /tmp', `echo x > /tmp/leak-st-$$.txt`, base);
const aWrite = await run('write into A', `echo x > ${A}/a.txt`, base);
console.log('');
console.log('--- with excludeTmpdirEnvVar + excludeSlashTmp ---');
const strict = { ...base, excludeTmpdirEnvVar: true, excludeSlashTmp: true };
const bWrite2 = await run('write into cwd B', `echo x > ${B}/b2.txt`, strict);
const tmpWrite2 = await run('write into $TMPDIR', `echo x > ${TMP}/leak-tmp2-$$.txt`, strict);
const slashTmp2 = await run('write into /tmp', `echo x > /tmp/leak-st2-$$.txt`, strict);
const aWrite2 = await run('write into A', `echo x > ${A}/a2.txt`, strict);
console.log('');
console.log('--- readOnly for comparison ---');
await run('readOnly: write into A', `echo x > ${A}/ro.txt`, { type: 'readOnly', networkAccess: false });
console.log('');
console.log(JSON.stringify({ cwdGranted: bWrite, tmpdirGranted: tmpWrite, slashTmpGranted: slashTmp, aGranted: aWrite,
  strict: { cwd: bWrite2, tmpdir: tmpWrite2, slashTmp: slashTmp2, a: aWrite2 } }, null, 1));
child.kill('SIGTERM');
process.exit(0);

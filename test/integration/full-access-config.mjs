#!/usr/bin/env node
/**
 * The admin opt-in must be storable, readable, and refused when wrong.
 *
 * Covers the public configuration surface (the trusted policy file is just JSON
 * with the same shape), a cold start and a reload, and the failure-closed cases.
 */
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveDirectOpsPolicy } from '../../lib/direct/policy.js';
import { createDirectOpsRuntime } from '../../lib/direct/tools.js';

// Machine-independent paths: everything is derived from HOME so this
// harness runs on any checkout, not just the author's machine.
const HOME = process.env.HOME ?? '';
const WORKSPACE = process.env.DSH_BRIDGE_WORKSPACE ?? `${HOME}/Work/CODEX`;
const CODEX_HOME_DIR = process.env.DSH_BRIDGE_CODEX_HOME ?? `${HOME}/.dsh/chatgpt-bridge/codex-home`;
const LIVE_POLICY = process.env.DSH_BRIDGE_POLICY ?? `${HOME}/.dsh/chatgpt-bridge/direct-ops/policy.json`;
const OUTSIDE_PROBE = `${HOME}/codex-backend-outside-probe.txt`;
const PLUGIN_LIB = process.env.DSH_BRIDGE_PLUGIN_LIB ?? `${HOME}/.dsh/profiles/desktop/node_modules/dsh-chatgpt-bridge/lib`;

const CODEX = '/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex';
const WS = WORKSPACE;
let fail = 0;
const check = (n, ok, d) => { console.log(`${ok ? 'OK  ' : 'FAIL'}  ${n}${ok ? '' : `  -> ${JSON.stringify(d)}`}`); if (!ok) fail += 1; };
const codeOf = (fn) => { try { fn(); return null; } catch (e) { return e?.code ?? String(e).slice(0, 40); } };

const dir = mkdtempSync(join(tmpdir(), 'full-access-config-'));
const policyFile = join(dir, 'policy.json');
const base = {
  enabled: true, allowWrites: true, roots: ['/', WS], writableRoots: ['/', WS],
  limits: { execTimeoutMs: 60000, execMaxTimeoutMs: 300000 },
  exec: {
    enabled: true, allowedCommands: [], cwdRoots: [WS], writableRoots: [WS], network: 'deny',
    filesystem: 'roots', sandbox: 'required', backend: 'codex-app-server', codexBin: CODEX,
    codexHome: CODEX_HOME_DIR, pathEntries: ['/opt/homebrew/bin'],
  },
};

// 1. a policy file carrying the opt-in loads on a cold start
writeFileSync(policyFile, JSON.stringify({ ...base, exec: { ...base.exec, fullAccess: true } }), 'utf8');
const loaded = resolveDirectOpsPolicy({ policyFile });
check('a stored fullAccess=true loads from the policy file', loaded.exec.fullAccess === true, loaded.exec.fullAccess);
check('an empty allowlist is allowed when full access is on', loaded.exec.allowedCommands.length === 0, loaded.exec.allowedCommands);

// 2. reload through the runtime is consistent with the cold start
const runtime = createDirectOpsRuntime({ policyFile });
check('the runtime reports the policy as reloadable', runtime.reloadable === true, runtime.reloadable);
check('runtime.policy() matches the cold start', runtime.policy().exec.fullAccess === true, runtime.policy().exec.fullAccess);
const reloaded = runtime.reload();
check('reload returns fullAccess=true as well', reloaded.exec.fullAccess === true, reloaded.exec.fullAccess);

// 3. flipping the file back off takes effect on reload (default stays closed).
// Note: a restricted policy needs an allowlist again, which is exactly the point
// of the check above — the empty allowlist is only legal while full access is on.
writeFileSync(policyFile, JSON.stringify({ ...base, exec: { ...base.exec, fullAccess: false, allowedCommands: ['sh'] } }), 'utf8');
check('reload picks up fullAccess=false', runtime.reload().exec.fullAccess === false, runtime.reload().exec.fullAccess);
writeFileSync(policyFile, JSON.stringify({ ...base, exec: { ...base.exec, fullAccess: false } }), 'utf8');
check('turning full access off re-requires an allowlist', codeOf(() => resolveDirectOpsPolicy({ policyFile })) === 'INVALID_ARGUMENT', 'accepted');
// restore the valid off-state for the remaining checks
writeFileSync(policyFile, JSON.stringify({ ...base, exec: { ...base.exec, fullAccess: false, allowedCommands: ['sh'] } }), 'utf8');

// 4. unknown / coercible values must not open it
writeFileSync(policyFile, JSON.stringify({ ...base, exec: { ...base.exec, fullAccess: 'true' } }), 'utf8');
check('a string "true" is refused, not coerced', codeOf(() => resolveDirectOpsPolicy({ policyFile })) === 'INVALID_ARGUMENT', 'coerced');
writeFileSync(policyFile, JSON.stringify({ ...base, exec: { ...base.exec, fullAccess: 1 } }), 'utf8');
check('the number 1 is refused', codeOf(() => resolveDirectOpsPolicy({ policyFile })) === 'INVALID_ARGUMENT', 'coerced');
writeFileSync(policyFile, JSON.stringify({ ...base, exec: { ...base.exec, fullAccess: 'yes' } }), 'utf8');
check('an arbitrary string is refused', codeOf(() => resolveDirectOpsPolicy({ policyFile })) === 'INVALID_ARGUMENT', 'coerced');

// 5. unsupported combinations fail closed
const local = { ...base, exec: { ...base.exec, fullAccess: true, backend: 'sandbox-exec' } };
check('fullAccess with the sandbox-exec backend is refused', codeOf(() => resolveDirectOpsPolicy(local)) === 'INVALID_ARGUMENT', 'accepted');
const disabled = { ...base, exec: { ...base.exec, fullAccess: true, enabled: false } };
check('fullAccess while exec is disabled is refused', codeOf(() => resolveDirectOpsPolicy(disabled)) === 'INVALID_ARGUMENT', 'accepted');
const noAllowlist = { ...base, exec: { ...base.exec, fullAccess: false, allowedCommands: [] } };
check('a restricted policy still requires an allowlist', codeOf(() => resolveDirectOpsPolicy(noAllowlist)) === 'INVALID_ARGUMENT', 'accepted');

// 6. the default is still closed
check('with no exec.fullAccess key the default is false', resolveDirectOpsPolicy({ ...base, exec: { ...base.exec, allowedCommands: ['sh'] } }).exec.fullAccess === false, 'open');

rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILURES'}`);
process.exit(fail === 0 ? 0 : 1);

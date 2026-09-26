/**
 * Direct command execution.
 *
 * Design rules, in order of importance:
 *   1. NO SHELL. The caller sends `cmd` (a bare executable name from the
 *      server-side allowlist) plus an argv array. We spawn with shell:false, so
 *      `;`, `|`, `$()`, globs and redirects are literal argv bytes and cannot
 *      compose a new command. This is a *reliability* rule, not the security
 *      boundary; any allowed interpreter still runs arbitrary code.
 *   2. The security boundary is the OS sandbox, and it is enforced for READS as
 *      well as writes. With `filesystem: "roots"` the profile denies
 *      `file-read*` by default and grants only the trusted roots, the cwd, the
 *      resolved binary and read-only system locations. That is what stops an
 *      allowlisted command from simply reading `~/.ssh` or the policy file and
 *      walking around the bridge's path denylist. Writes are granted only for
 *      `exec.writableRoots`.
 *   3. A cwd is NOT a boundary and NOT a write grant. It only decides where
 *      relative paths resolve. `exec.writableRoots` decides writes, and it is
 *      empty unless the host enabled writes and named a root.
 *   4. Fail closed. `sandbox: "required"` (the default) refuses to run when no
 *      OS sandbox is available rather than silently running bare.
 *   5. Bounded: per-stream byte budget with explicit truncation flags, a timeout
 *      that kills the whole process group (SIGTERM then SIGKILL), and a capped
 *      timeout argument. Nothing here can hang the MCP transport unbounded.
 *   6. Credential hygiene: the child env is rebuilt from an explicit passthrough
 *      list, so provider keys and bridge tokens are not inherited by default.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { resolveExistingTarget } from './path-security.js';
import { scrubSecrets, scrubPathForDisplay } from './secrets.js';
import { assertSandboxAvailable, buildSandboxProfile, resolveAllowedCommand, sandboxExecAvailable, sandboxKind, } from './policy.js';
import { runCommandViaCodex } from './codex-backend.js';
import { DirectOpsError } from './types.js';
const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';
const KILL_GRACE_MS = 2000;
export function buildChildEnv(policy, overrides) {
    const env = {};
    for (const key of policy.exec.envPassthrough) {
        const value = process.env[key];
        if (value !== undefined)
            env[key] = value;
    }
    if (policy.exec.pathEntries.length > 0) {
        const current = env.PATH ?? '';
        env.PATH = [current, ...policy.exec.pathEntries].filter((part) => part !== '').join(':');
    }
    // Caller overrides can add harmless variables but cannot re-introduce a
    // credential-shaped name.
    for (const [key, value] of Object.entries(overrides ?? {})) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            throw new DirectOpsError('INVALID_ARGUMENT', `env key is not a valid identifier: ${key}`);
        }
        if (/(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH)/i.test(key)) {
            throw new DirectOpsError('INVALID_ARGUMENT', `env override "${key}" looks credential-shaped and is refused; the direct surface never carries secrets`);
        }
        env[key] = value;
    }
    return env;
}
/** Whether `path` is one of `roots` or sits beneath one. */
export function withinAnyRoot(path, roots) {
    return roots.some((root) => {
        const normalized = root.endsWith('/') ? root.slice(0, -1) : root;
        return path === normalized || path.startsWith(`${normalized}/`);
    });
}
export function resolveCwd(input, policy) {
    // Administrator full access: the working directory may be any existing
    // directory. Relative and non-existent paths are still refused.
    if (policy.exec.fullAccess) {
        if (input === undefined || input === '') {
            throw new DirectOpsError('INVALID_ARGUMENT', 'full-access mode requires an explicit absolute cwd; there is no default directory to guess');
        }
        if (!isAbsolute(input)) {
            throw new DirectOpsError('INVALID_ARGUMENT', 'cwd must be an absolute path', { cwd: input });
        }
        let real;
        try {
            real = realpathSync.native(input);
            if (!statSync(real).isDirectory()) {
                throw new DirectOpsError('INVALID_ARGUMENT', 'cwd is not a directory', { cwd: input });
            }
        }
        catch (error) {
            if (error instanceof DirectOpsError)
                throw error;
            throw new DirectOpsError('INVALID_ARGUMENT', 'cwd does not exist', { cwd: input });
        }
        return real;
    }
    const candidates = input !== undefined && input !== '' ? [input] : policy.exec.cwdRoots;
    if (candidates.length === 0) {
        throw new DirectOpsError('INVALID_ARGUMENT', 'no cwd was supplied and exec.cwdRoots is empty; configure a cwd root before running commands');
    }
    const errors = [];
    for (const candidate of candidates) {
        try {
            // Reuse the read-path resolver: an exec cwd must be an existing directory
            // inside a trusted root, with the same symlink and denylist checks.
            const target = resolveExistingTarget(candidate, policy, { skipProtection: true });
            if (!statSync(target.canonical).isDirectory()) {
                errors.push(`${scrubPathForDisplay(target.canonical)}: not a directory`);
                continue;
            }
            // A trusted root is not enough: `exec.cwdRoots` is its own, narrower list.
            // Without this check a configured cwd root would be advisory, and a caller
            // could run a command in any trusted root — including one the operator
            // deliberately excluded from command execution.
            if (!withinAnyRoot(target.canonical, policy.exec.cwdRoots)) {
                errors.push(`${scrubPathForDisplay(target.canonical)}: outside exec.cwdRoots (${policy.exec.cwdRoots.length} configured)`);
                continue;
            }
            return target.canonical;
        }
        catch (error) {
            errors.push(error instanceof Error ? scrubSecrets(error.message) : String(error));
        }
    }
    throw new DirectOpsError('PATH_OUTSIDE_ROOTS', 'cwd is not usable inside any trusted root', {
        tried: errors.slice(0, 4),
    });
}
function realpathOrSelf(path) {
    try {
        return realpathSync.native(path);
    }
    catch {
        return path;
    }
}
/**
 * Paths the child must never read or write even though they may sit inside an
 * allowed root.
 *
 * The OS sandbox re-allows each configured root wholesale, which would otherwise
 * hand a child back the very files the bridge's own handlers refuse: the policy
 * file that governs it, credential files matching the denylist, and any path the
 * host added to deniedNames. Those are re-denied here, after the root allows, so
 * the sandbox enforces the same policy the direct file tools enforce.
 *
 * The walk is bounded (depth and entry caps) because a root may be a large tree;
 * the bound is stated in the result-visible policy notes rather than hidden.
 */
const DENIED_WALK_MAX_ENTRIES = 20000;
const DENIED_WALK_MAX_DEPTH = 6;
function deniedReadPaths(policy) {
    const denied = new Set(policy.protectedPaths);
    const home = process.env.HOME;
    if (home !== undefined && home !== '') {
        for (const name of ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.config/gh']) {
            denied.add(join(home, name));
        }
    }
    const deniedNames = new Set(policy.deniedNames.map((name) => name.toLowerCase()));
    let visited = 0;
    const walk = (dir, depth) => {
        if (depth > DENIED_WALK_MAX_DEPTH || visited > DENIED_WALK_MAX_ENTRIES)
            return;
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            visited += 1;
            if (visited > DENIED_WALK_MAX_ENTRIES)
                return;
            const lower = entry.name.toLowerCase();
            const full = join(dir, entry.name);
            if (deniedNames.has(lower)) {
                denied.add(full);
                continue;
            }
            for (const pattern of policy.deniedBasenames) {
                pattern.lastIndex = 0;
                if (pattern.test(entry.name)) {
                    denied.add(full);
                    break;
                }
            }
            if (entry.isDirectory())
                walk(full, depth + 1);
        }
    };
    for (const root of policy.roots) {
        walk(root.real, 0);
    }
    return [...denied];
}
function planSandbox(binary, args, policy, cwd) {
    const writableRoots = policy.exec.filesystem === 'roots'
        ? policy.exec.writableRoots.map(realpathOrSelf)
        : [];
    const applied = assertSandboxAvailable(policy);
    if (!applied)
        return { command: binary, args, applied: false, writableRoots: [] };
    const profile = buildSandboxProfile({
        policy,
        cwd: realpathOrSelf(cwd),
        binary: realpathOrSelf(binary),
        readableRoots: policy.roots.map((root) => root.real),
        writableRoots,
        deniedReadPaths: deniedReadPaths(policy),
    });
    const profileFile = join(tmpdir(), `dsh-direct-sandbox-${randomBytes(6).toString('hex')}.sb`);
    writeFileSync(profileFile, profile, { encoding: 'utf8', mode: 0o600 });
    return {
        command: SANDBOX_EXEC_PATH,
        args: ['-f', profileFile, binary, ...args],
        applied: true,
        profileFile,
        writableRoots,
    };
}
/**
 * Build the ONE effective sandbox envelope used by every command result.
 *
 * `applied` alone decides whether the configured boundary is in force. When no
 * OS sandbox confines the child, network and filesystem are reported as
 * `unconfined` and the configured values move to `configured_*`, so a result can
 * never say `network: "deny"` next to a child that was in fact online.
 */
export function effectiveSandboxEnvelope(input) {
    const { kind, applied, fullAccess, configured, extra } = input;
    return {
        kind: applied ? kind : 'none',
        network: applied ? configured.network : 'unconfined',
        filesystem: applied ? configured.filesystem : 'unconfined',
        applied,
        cwd_grants_writes: fullAccess,
        cwd_restricted: applied,
        command_restricted: !fullAccess,
        ...(applied ? {} : { configured_network: configured.network, configured_filesystem: configured.filesystem }),
        // A confined backend with no write roots has no writable path at all; report
        // that as an empty list rather than pretending a boundary exists.
        ...(applied
            ? (configured.writableRoots.length > 0 ? { writable_roots: configured.writableRoots } : {})
            : { writable_roots: 'unconfined' }),
        ...(extra ?? {}),
    };
}
export async function runCommand(input, policy) {
    const started = Date.now();
    if (!policy.enabled) {
        throw new DirectOpsError('DIRECT_OPS_DISABLED', 'direct operations are disabled by the host configuration');
    }
    if (!policy.exec.enabled) {
        throw new DirectOpsError('EXEC_DISABLED', 'direct command execution is disabled. It is a high-privilege capability that a local administrator must '
            + 'enable explicitly (directOps.exec.enabled=true plus an allowlist); the bridge never opens it by default.');
    }
    if (input.args !== undefined && (!Array.isArray(input.args) || input.args.some((item) => typeof item !== 'string'))) {
        throw new DirectOpsError('INVALID_ARGUMENT', 'args must be an array of strings');
    }
    if (policy.exec.backend === 'codex-app-server') {
        return runCommandViaCodexBackend(input, policy, started);
    }
    const timeoutMs = Math.min(input.timeout_ms !== undefined && input.timeout_ms > 0 ? Math.trunc(input.timeout_ms) : policy.limits.execTimeoutMs, policy.limits.execMaxTimeoutMs);
    const maxOutput = Math.min(input.max_output_bytes !== undefined && input.max_output_bytes > 0
        ? Math.trunc(input.max_output_bytes)
        : policy.limits.execMaxOutputBytes, policy.limits.execMaxOutputBytes);
    const cwd = resolveCwd(input.cwd, policy);
    const { path: binary } = resolveAllowedCommand(input.cmd, policy);
    const args = (input.args ?? []).map((item) => String(item));
    const plan = planSandbox(binary, args, policy, cwd);
    const childEnv = buildChildEnv(policy, input.env);
    const outcome = await spawnBounded({
        command: plan.command,
        args: plan.args,
        cwd,
        env: childEnv,
        timeoutMs,
        maxOutput,
    });
    if (plan.profileFile !== undefined) {
        try {
            unlinkSync(plan.profileFile);
        }
        catch {
            // The profile file holds no secrets; a failed unlink is harmless.
        }
    }
    return {
        cmd: input.cmd,
        argv: [input.cmd, ...args],
        cwd,
        resolved_binary: binary,
        exit_code: outcome.exitCode,
        signal: outcome.signal,
        timed_out: outcome.timedOut,
        duration_ms: Date.now() - started,
        stdout: scrubSecrets(outcome.stdout),
        stderr: scrubSecrets(outcome.stderr),
        stdout_bytes: outcome.stdoutBytes,
        stderr_bytes: outcome.stderrBytes,
        stdout_truncated: outcome.stdoutTruncated,
        stderr_truncated: outcome.stderrTruncated,
        max_output_bytes: maxOutput,
        backend: 'sandbox-exec',
        sandbox: effectiveSandboxEnvelope({
            kind: sandboxKind(),
            applied: plan.applied,
            // This backend cannot serve full access (it is refused at resolution), so
            // `applied` alone decides what is reported as effective.
            fullAccess: false,
            configured: {
                network: policy.exec.network,
                filesystem: policy.exec.filesystem,
                writableRoots: plan.writableRoots,
            },
            ...(plan.applied && policy.exec.filesystem === 'roots'
                ? { extra: { readable_roots: policy.roots.map((root) => root.real) } }
                : {}),
        }),
        env_keys: Object.keys(childEnv).sort(),
    };
}
function spawnBounded(options) {
    return new Promise((resolvePromise) => {
        let child;
        try {
            child = spawn(options.command, options.args, {
                cwd: options.cwd,
                env: options.env,
                shell: false,
                detached: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        }
        catch (error) {
            resolvePromise({
                exitCode: null,
                signal: null,
                timedOut: false,
                stdout: '',
                stderr: scrubSecrets(`spawn failed: ${error.message}`),
                stdoutBytes: 0,
                stderrBytes: 0,
                stdoutTruncated: false,
                stderrTruncated: false,
            });
            return;
        }
        let stdout = '';
        let stderr = '';
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let stdoutTruncated = false;
        let stderrTruncated = false;
        let timedOut = false;
        let settled = false;
        const killGroup = (signal) => {
            const pid = child.pid;
            if (pid === undefined)
                return;
            try {
                // Negative pid targets the whole process group: a child that spawned
                // grandchildren must not survive our timeout.
                process.kill(-pid, signal);
            }
            catch {
                try {
                    child.kill(signal);
                }
                catch {
                    // already gone
                }
            }
        };
        const timer = setTimeout(() => {
            timedOut = true;
            killGroup('SIGTERM');
            const hard = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
            hard.unref?.();
        }, options.timeoutMs);
        timer.unref?.();
        const collect = (chunk, stream) => {
            const isOut = stream === 'stdout';
            const used = isOut ? stdoutBytes : stderrBytes;
            const room = options.maxOutput - used;
            if (room <= 0) {
                if (isOut)
                    stdoutTruncated = true;
                else
                    stderrTruncated = true;
                return;
            }
            const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
            const text = slice.toString('utf8');
            if (isOut) {
                stdout += text;
                stdoutBytes += slice.length;
                if (chunk.length > room)
                    stdoutTruncated = true;
            }
            else {
                stderr += text;
                stderrBytes += slice.length;
                if (chunk.length > room)
                    stderrTruncated = true;
            }
        };
        child.stdout?.on('data', (chunk) => collect(chunk, 'stdout'));
        child.stderr?.on('data', (chunk) => collect(chunk, 'stderr'));
        child.on('error', (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            stderr += scrubSecrets(`${stderr === '' ? '' : '\n'}spawn error: ${error.message}`);
            resolvePromise({
                exitCode: null,
                signal: null,
                timedOut,
                stdout,
                stderr,
                stdoutBytes,
                stderrBytes,
                stdoutTruncated,
                stderrTruncated,
            });
        });
        child.on('close', (code, signal) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolvePromise({
                exitCode: code,
                signal: signal ?? null,
                timedOut,
                stdout,
                stderr,
                stdoutBytes,
                stderrBytes,
                stdoutTruncated,
                stderrTruncated,
            });
        });
    });
}
export { sandboxExecAvailable };
/**
 * Run one command through the codex app-server backend.
 *
 * Shares the caller-facing envelope with the sandbox-exec path so
 * `dsh_run_command` keeps one result shape and one set of limits, and reports
 * the sandbox that was really applied rather than the one that was requested.
 */
async function runCommandViaCodexBackend(input, policy, started) {
    const timeoutMs = Math.min(input.timeout_ms !== undefined && input.timeout_ms > 0 ? Math.trunc(input.timeout_ms) : policy.limits.execTimeoutMs, policy.limits.execMaxTimeoutMs);
    const maxOutput = Math.min(input.max_output_bytes !== undefined && input.max_output_bytes > 0
        ? Math.trunc(input.max_output_bytes)
        : policy.limits.execMaxOutputBytes, policy.limits.execMaxOutputBytes);
    const cwd = resolveCwd(input.cwd, policy);
    const args = (input.args ?? []).map((item) => String(item));
    const childEnv = buildChildEnv(policy, input.env);
    const outcome = await runCommandViaCodex({ cmd: input.cmd, args, cwd, timeoutMs, maxOutputBytes: maxOutput, env: childEnv }, policy);
    const stdout = scrubSecrets(outcome.stdout);
    const stderr = scrubSecrets(outcome.stderr);
    return {
        cmd: input.cmd,
        argv: [input.cmd, ...args],
        cwd,
        resolved_binary: outcome.resolvedBinary,
        exit_code: outcome.exitCode,
        // codex returns an exit code, not a POSIX signal, so no signal is claimed.
        signal: null,
        // Never derived from `exitCode === 124`: a command may exit 124 itself.
        // Only the adapter's own evidence sets this.
        timed_out: outcome.timedOut,
        duration_ms: Date.now() - started,
        stdout,
        stderr,
        stdout_bytes: Buffer.byteLength(stdout, 'utf8'),
        stderr_bytes: Buffer.byteLength(stderr, 'utf8'),
        // Truncation is the server's own report when it has one; byte-count
        // inference is only a fallback, because "the buffer is full" is not proof
        // that anything was dropped.
        stdout_truncated: outcome.stdoutTruncated ?? Buffer.byteLength(stdout, 'utf8') >= maxOutput,
        stderr_truncated: outcome.stderrTruncated ?? Buffer.byteLength(stderr, 'utf8') >= maxOutput,
        max_output_bytes: maxOutput,
        backend: 'codex-app-server',
        sandbox: effectiveSandboxEnvelope({
            kind: 'codex-app-server',
            applied: outcome.sandbox.describe.sandboxed !== false,
            fullAccess: policy.exec.fullAccess,
            configured: {
                network: policy.exec.network,
                filesystem: policy.exec.filesystem,
                writableRoots: policy.exec.writableRoots,
            },
            extra: {
                codex_policy: String(outcome.sandbox.describe.codex_policy ?? ''),
                ...(outcome.sandbox.describe.note === undefined ? {} : { note: String(outcome.sandbox.describe.note) }),
                ...(outcome.sandbox.describe.read_scope === undefined
                    ? {}
                    : { read_scope: String(outcome.sandbox.describe.read_scope) }),
                ...(outcome.sandbox.describe.write_scope === undefined
                    ? {}
                    : { write_scope: String(outcome.sandbox.describe.write_scope) }),
            },
        }),
        env_keys: Object.keys(childEnv).sort(),
    };
}

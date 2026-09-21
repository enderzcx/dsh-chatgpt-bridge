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
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveExistingTarget } from './path-security.js';
import { scrubSecrets, scrubPathForDisplay } from './secrets.js';
import {
  assertSandboxAvailable,
  buildSandboxProfile,
  resolveAllowedCommand,
  sandboxExecAvailable,
  sandboxKind,
} from './policy.js';
import { DirectOpsError, type DirectOpsPolicy } from './types.js';

const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';
const KILL_GRACE_MS = 2000;

export interface ExecInput {
  cmd: string;
  args?: string[];
  cwd?: string;
  timeout_ms?: number;
  max_output_bytes?: number;
  env?: Record<string, string>;
}

export interface ExecResult {
  cmd: string;
  argv: string[];
  cwd: string;
  resolved_binary: string;
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  duration_ms: number;
  stdout: string;
  stderr: string;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  max_output_bytes: number;
  sandbox: {
    kind: string;
    network: 'deny' | 'allow';
    /** 'roots' means reads AND writes are confined by the OS sandbox. */
    filesystem: 'roots' | 'inherit';
    applied: boolean;
    /** Cwd is reported so a caller can see it is a location, not a boundary. */
    cwd_grants_writes: false;
    readable_roots?: string[];
    writable_roots?: string[];
  };
  env_keys: string[];
}

function buildChildEnv(policy: DirectOpsPolicy, overrides?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of policy.exec.envPassthrough) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
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
      throw new DirectOpsError(
        'INVALID_ARGUMENT',
        `env override "${key}" looks credential-shaped and is refused; the direct surface never carries secrets`,
      );
    }
    env[key] = value;
  }
  return env;
}

function resolveCwd(input: string | undefined, policy: DirectOpsPolicy): string {
  const candidates = input !== undefined && input !== '' ? [input] : policy.exec.cwdRoots;
  if (candidates.length === 0) {
    throw new DirectOpsError(
      'INVALID_ARGUMENT',
      'no cwd was supplied and exec.cwdRoots is empty; configure a cwd root before running commands',
    );
  }
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      // Reuse the read-path resolver: an exec cwd must be an existing directory
      // inside a trusted root, with the same symlink and denylist checks.
      const target = resolveExistingTarget(candidate, policy, { skipProtection: true });
      if (!statSync(target.canonical).isDirectory()) {
        errors.push(`${scrubPathForDisplay(target.canonical)}: not a directory`);
        continue;
      }
      return target.canonical;
    } catch (error) {
      errors.push(error instanceof Error ? scrubSecrets(error.message) : String(error));
    }
  }
  throw new DirectOpsError('PATH_OUTSIDE_ROOTS', 'cwd is not usable inside any trusted root', {
    tried: errors.slice(0, 4),
  });
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
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

function deniedReadPaths(policy: DirectOpsPolicy): string[] {
  const denied = new Set<string>(policy.protectedPaths);
  const home = process.env.HOME;
  if (home !== undefined && home !== '') {
    for (const name of ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.config/gh']) {
      denied.add(join(home, name));
    }
  }
  const deniedNames = new Set(policy.deniedNames.map((name) => name.toLowerCase()));
  let visited = 0;

  const walk = (dir: string, depth: number): void => {
    if (depth > DENIED_WALK_MAX_DEPTH || visited > DENIED_WALK_MAX_ENTRIES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > DENIED_WALK_MAX_ENTRIES) return;
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
      if (entry.isDirectory()) walk(full, depth + 1);
    }
  };

  for (const root of policy.roots) {
    walk(root.real, 0);
  }
  return [...denied];
}

interface SandboxPlan {
  command: string;
  args: string[];
  applied: boolean;
  profileFile?: string;
  writableRoots: string[];
}

function planSandbox(
  binary: string,
  args: string[],
  policy: DirectOpsPolicy,
  cwd: string,
): SandboxPlan {
  const writableRoots = policy.exec.filesystem === 'roots'
    ? policy.exec.writableRoots.map(realpathOrSelf)
    : [];
  const applied = assertSandboxAvailable(policy);
  if (!applied) return { command: binary, args, applied: false, writableRoots: [] };

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

export async function runCommand(input: ExecInput, policy: DirectOpsPolicy): Promise<ExecResult> {
  const started = Date.now();
  if (!policy.enabled) {
    throw new DirectOpsError('DIRECT_OPS_DISABLED', 'direct operations are disabled by the host configuration');
  }
  if (!policy.exec.enabled) {
    throw new DirectOpsError(
      'EXEC_DISABLED',
      'direct command execution is disabled. It is a high-privilege capability that a local administrator must '
        + 'enable explicitly (directOps.exec.enabled=true plus an allowlist); the bridge never opens it by default.',
    );
  }
  if (input.args !== undefined && (!Array.isArray(input.args) || input.args.some((item) => typeof item !== 'string'))) {
    throw new DirectOpsError('INVALID_ARGUMENT', 'args must be an array of strings');
  }
  const timeoutMs = Math.min(
    input.timeout_ms !== undefined && input.timeout_ms > 0 ? Math.trunc(input.timeout_ms) : policy.limits.execTimeoutMs,
    policy.limits.execMaxTimeoutMs,
  );
  const maxOutput = Math.min(
    input.max_output_bytes !== undefined && input.max_output_bytes > 0
      ? Math.trunc(input.max_output_bytes)
      : policy.limits.execMaxOutputBytes,
    policy.limits.execMaxOutputBytes,
  );
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
    } catch {
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
    sandbox: {
      kind: sandboxKind(),
      network: policy.exec.network,
      filesystem: policy.exec.filesystem,
      applied: plan.applied,
      cwd_grants_writes: false,
      ...(plan.applied && policy.exec.filesystem === 'roots'
        ? {
          readable_roots: policy.roots.map((root) => root.real),
          writable_roots: plan.writableRoots,
        }
        : {}),
    },
    env_keys: Object.keys(childEnv).sort(),
  };
}

interface SpawnOutcome {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

function spawnBounded(options: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxOutput: number;
}): Promise<SpawnOutcome> {
  return new Promise<SpawnOutcome>((resolvePromise) => {
    let child: ChildProcess;
    try {
      child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolvePromise({
        exitCode: null,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: scrubSecrets(`spawn failed: ${(error as Error).message}`),
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

    const killGroup = (signal: NodeJS.Signals) => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        // Negative pid targets the whole process group: a child that spawned
        // grandchildren must not survive our timeout.
        process.kill(-pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
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

    const collect = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      const isOut = stream === 'stdout';
      const used = isOut ? stdoutBytes : stderrBytes;
      const room = options.maxOutput - used;
      if (room <= 0) {
        if (isOut) stdoutTruncated = true;
        else stderrTruncated = true;
        return;
      }
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
      const text = slice.toString('utf8');
      if (isOut) {
        stdout += text;
        stdoutBytes += slice.length;
        if (chunk.length > room) stdoutTruncated = true;
      } else {
        stderr += text;
        stderrBytes += slice.length;
        if (chunk.length > room) stderrTruncated = true;
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => collect(chunk, 'stdout'));
    child.stderr?.on('data', (chunk: Buffer) => collect(chunk, 'stderr'));

    child.on('error', (error: Error) => {
      if (settled) return;
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

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
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

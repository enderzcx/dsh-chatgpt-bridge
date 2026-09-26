/**
 * The `codex-app-server` execution backend.
 *
 * Responsibilities kept deliberately narrow:
 *   1. **Permission translation.** The server-configured policy is the ceiling.
 *      A caller may choose an allowed command and a cwd; it can never widen the
 *      sandbox. `writableRoots` comes only from the policy, network access only
 *      from the policy, and a write request without configured write roots is
 *      refused rather than upgraded.
 *   2. **Session isolation.** Every execution gets its own app-server process and
 *      its own `processId`, so no run can read or terminate another run's
 *      process, and a crash cannot take unrelated runs down.
 *   3. **No model.** Only `command/exec` is sent. The client refuses any
 *      thread/turn-shaped method, so no thread, turn, or model call is possible.
 */
import { mkdirSync } from 'node:fs';
import { resolveAllowedCommand } from './policy.js';
import { buildCodexEnv } from './secrets.js';
import { CodexAppServerClient, CodexClientError, type CodexSandboxPolicy } from './codex-app-server.js';
import { DirectOpsError, type DirectOpsErrorCode, type DirectOpsPolicy } from './types.js';

/** Adapter codes that the direct surface already understands. */
const DIRECT_OPS_CODES: readonly DirectOpsErrorCode[] = [
  'CODEX_BIN_UNCONFIGURED',
  'CODEX_POLICY_UNSUPPORTED',
  'CODEX_SPAWN_FAILED',
  'CODEX_RPC_ERROR',
  'CODEX_REQUEST_TIMEOUT',
  'CODEX_WRITE_FAILED',
  'CODEX_BAD_RESULT',
  'CODEX_NOT_RUNNING',
  'CODEX_EXITED',
  'CODEX_CLOSED',
  'CODEX_ALREADY_STARTED',
  'CODEX_EMPTY_COMMAND',
  'CODEX_METHOD_NOT_ALLOWED',
  'CODEX_EXEC_FAILED',
];

/** The sandbox policy actually handed to codex, plus the honest description. */
export interface CodexSandboxPlan {
  policy: CodexSandboxPolicy;
  describe: Record<string, unknown>;
}

/** What the child is ACTUALLY confined by, as opposed to what was configured. */
export interface EffectiveConfinement {
  /** True only when an OS sandbox really confines this child. */
  sandboxed: boolean;
  /** Effective network reach, not the configured intent. */
  network: 'deny' | 'allow' | 'unconfined';
  /** Effective filesystem scope, not the configured intent. */
  filesystem: 'roots' | 'inherit' | 'unconfined';
  /** Cwd is unconstrained (full access) rather than restricted to cwd roots. */
  cwdUnrestricted: boolean;
  /** Any bare executable name resolves rather than only an allowlist. */
  commandUnrestricted: boolean;
}

/**
 * Derive the effective confinement from the plan.
 *
 * This is the ONE place that decides what the result and the policy view report,
 * so a configured `network: deny` can never be echoed next to a child that is in
 * fact online.
 */
export function effectiveConfinement(plan: CodexSandboxPlan): EffectiveConfinement {
  if (plan.describe.sandboxed === false) {
    return {
      sandboxed: false,
      network: 'unconfined',
      filesystem: 'unconfined',
      cwdUnrestricted: true,
      commandUnrestricted: true,
    };
  }
  return {
    sandboxed: true,
    // `dangerFullAccess` carries no networkAccess member, so read defensively.
    network: (plan.policy as { networkAccess?: boolean }).networkAccess === true ? 'allow' : 'deny',
    filesystem: 'roots',
    cwdUnrestricted: false,
    commandUnrestricted: false,
  };
}

/** The absolute codex executable, or a refusal naming the configuration key. */
export function resolveCodexBinary(policy: DirectOpsPolicy): string {
  const bin = policy.exec.codexBin;
  if (bin === undefined || bin.trim() === '') {
    throw new DirectOpsError(
      'CODEX_BIN_UNCONFIGURED',
      'exec.backend is "codex-app-server" but exec.codexBin is not set; a local administrator must name the '
        + 'codex executable (for example /opt/homebrew/bin/codex). The bridge never guesses it from PATH.',
      { backend: policy.exec.backend },
    );
  }
  return bin;
}

/**
 * Translate the bridge's direct-ops policy into a codex sandbox policy.
 *
 * This is the single place where the two permission models meet. It is
 * intentionally one-directional: every branch is decided by the policy, and an
 * unrecognised combination fails closed instead of falling back to a wider mode.
 */
export function planCodexSandbox(policy: DirectOpsPolicy, cwd: string): CodexSandboxPlan {
  const { filesystem, network, writableRoots } = policy.exec;
  const networkAccess = network === 'allow';

  if (policy.exec.fullAccess) {
    // Administrator-only: no OS confinement at all. Reported as such — `applied`
    // is false and the description says there is no sandbox, so nothing downstream
    // can keep claiming a boundary that is not there.
    return {
      policy: { type: 'dangerFullAccess' },
      describe: {
        backend: 'codex-app-server',
        codex_policy: 'dangerFullAccess',
        sandboxed: false,
        network: 'unconfined',
        read_scope: 'unconfined: the whole filesystem is readable by the child',
        write_scope: 'unconfined: any path the OS user can write',
        temp_writes: 'unconfined: $TMPDIR and /tmp are writable like anywhere else',
        writable_roots: 'unconfined',
        cwd,
        cwd_grants_writes: true,
        note: 'administrator full-access mode is ON: the child runs with no OS sandbox',
      },
    };
  }

  if (filesystem === 'inherit') {
    // The operator explicitly asked for the host to inherit its own confinement.
    // codex has no "inherit" mode, so this configuration is refused rather than
    // silently promoted to full access.
    throw new DirectOpsError(
      'CODEX_POLICY_UNSUPPORTED',
      'exec.filesystem="inherit" has no codex-app-server equivalent; refusing rather than granting '
        + 'danger-full-access. Use exec.filesystem="roots" with exec.writableRoots to grant writes.',
      { filesystem, backend: policy.exec.backend },
    );
  }

  if (writableRoots.length === 0) {
    return {
      // A readOnly policy could NOT be verified to reach the filesystem on this
      // host: every command failed with a Seatbelt violation before running, so
      // a readOnly deployment must be re-verified on the target machine. The
      // workspaceWrite path is the one measured to work.
      policy: { type: 'readOnly', networkAccess },
      describe: {
        backend: 'codex-app-server',
        codex_policy: 'readOnly',
        network: networkAccess ? 'allowed' : 'denied',
        verified: 'unverified-on-this-host',
        // Read scope is NOT the trusted roots: codex readOnly allows the system
        // to read broadly and only denies writes. Say so instead of implying the
        // bridge's root confinement carried over.
        read_scope: 'host-wide reads permitted by codex readOnly (not confined to trusted roots)',
        write_scope: 'none',
        cwd,
        cwd_grants_writes: false,
      },
    };
  }

  return {
    policy: {
      type: 'workspaceWrite',
      writableRoots: [...writableRoots],
      // Verified against the installed codex: workspaceWrite grants writes to
      // $TMPDIR and /tmp UNLESS these are set, regardless of writableRoots. Two
      // probe runs with writableRoots=[A] gave: tmp writes allowed by default,
      // both denied once these flags are on. The cwd is never granted (see
      // below), so these two flags are the whole difference between "writes
      // only where configured" and "writes wherever the host's temp happens to
      // be". They are part of the isolation, not an optimisation.
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
      networkAccess,
    },
    describe: {
      backend: 'codex-app-server',
      codex_policy: 'workspaceWrite',
      network: networkAccess ? 'allowed' : 'denied',
      read_scope: 'host-wide reads permitted by codex workspaceWrite (not confined to trusted roots)',
      // Measured, not assumed: with the two exclude flags set, a write to a
      // directory that is neither a writableRoot nor the cwd is refused, as is a
      // write to $TMPDIR, /tmp, and a readOnly-mode write.
      write_scope: 'only the configured exec.writableRoots (cwd, $TMPDIR and /tmp excluded)',
      writable_roots: [...writableRoots],
      temp_writes: 'excluded',
      cwd,
      cwd_grants_writes: false,
    },
  };
}

/** Options for one codex-backed execution. */
export interface CodexRunOptions {
  cmd: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  env: Record<string, string>;
}

/** Translate an adapter failure into the direct surface's error vocabulary. */
function asDirectOpsError(error: unknown): DirectOpsError {
  if (error instanceof DirectOpsError) return error;
  if (error instanceof CodexClientError) {
    // Adapter codes are a subset of the direct surface's vocabulary; anything
    // unexpected still surfaces as a codex failure rather than a bare internal.
    const code = (DIRECT_OPS_CODES as readonly string[]).includes(error.code)
      ? (error.code as DirectOpsErrorCode)
      : 'CODEX_EXEC_FAILED';
    return new DirectOpsError(code, error.message, error.details);
  }
  return new DirectOpsError('CODEX_EXEC_FAILED', error instanceof Error ? error.message : String(error));
}

/**
 * Spawn one dedicated app server, run one job, then stop it.
 *
 * A per-execution process is what keeps sessions isolated: one run's `processId`
 * namespace, stderr and lifetime cannot collide with another's.
 */
async function withClient<T>(
  policy: DirectOpsPolicy,
  onOutputDelta: ((stream: 'stdout' | 'stderr', text: string, capReached: boolean) => void) | undefined,
  job: (client: CodexAppServerClient) => Promise<T>,
): Promise<T> {
  const binPath = resolveCodexBinary(policy);
  if (policy.exec.codexHome !== undefined && policy.exec.codexHome !== '') {
    // The child refuses to start if its codex home does not exist.
    mkdirSync(policy.exec.codexHome, { recursive: true, mode: 0o700 });
  }
  const client = new CodexAppServerClient({
    binPath,
    binArgs: policy.exec.codexArgs,
    // Only the policy's passthrough keys reach the child; nothing else is
    // inherited, so no bridge or provider credential can leak into it.
    env: buildCodexEnv(policy),
    ...(onOutputDelta === undefined
      ? {}
      : {
        onOutputDelta: (delta) => onOutputDelta(delta.stream, delta.text, delta.capReached),
      }),
  });
  try {
    await client.start();
  } catch (error) {
    await client.close().catch(() => undefined);
    throw asDirectOpsError(error);
  }
  try {
    return await job(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * Run one allowlisted command through codex and wait for it to exit.
 *
 * A timeout is reported as `exitCode: 124` by the server, which is surfaced as
 * `timedOut` rather than as an error.
 */
export async function runCommandViaCodex(
  options: CodexRunOptions,
  policy: DirectOpsPolicy,
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True only when the runner's deadline was hit; see the adapter's evidence. */
  timedOut: boolean;
  timeoutEvidence: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  resolvedBinary: string;
  sandbox: CodexSandboxPlan;
  confinement: EffectiveConfinement;
}> {
  const { path: binary } = resolveAllowedCommand(options.cmd, policy);
  const plan = planCodexSandbox(policy, options.cwd);
  return withClient(policy, undefined, async (client) => {
    const result = await client.exec({
      command: [binary, ...options.args],
      cwd: options.cwd,
      env: options.env,
      sandboxPolicy: plan.policy,
      timeoutMs: options.timeoutMs,
      outputBytesCap: options.maxOutputBytes,
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      // The exit code is reported verbatim; `timedOut` comes from the adapter's
      // evidence, so a command that exits 124 by itself is not mislabelled.
      timedOut: result.timeout,
      timeoutEvidence: result.timeoutEvidence,
      ...(result.stdoutTruncated === undefined ? {} : { stdoutTruncated: result.stdoutTruncated }),
      ...(result.stderrTruncated === undefined ? {} : { stderrTruncated: result.stderrTruncated }),
      resolvedBinary: binary,
      sandbox: plan,
      confinement: effectiveConfinement(plan),
    };
  });
}

/** Start one allowlisted command as a streaming, terminable async run. */
export async function startCommandViaCodex(
  options: CodexRunOptions & { processId: string },
  policy: DirectOpsPolicy,
  onOutputDelta: (stream: 'stdout' | 'stderr', text: string, capReached: boolean) => void,
): Promise<{
  resolvedBinary: string;
  sandbox: CodexSandboxPlan;
  run: (client: CodexAppServerClient) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}> {
  const { path: binary } = resolveAllowedCommand(options.cmd, policy);
  const plan = planCodexSandbox(policy, options.cwd);
  return {
    resolvedBinary: binary,
    sandbox: plan,
    run: (client) => client.exec({
      command: [binary, ...options.args],
      cwd: options.cwd,
      env: options.env,
      sandboxPolicy: plan.policy,
      timeoutMs: options.timeoutMs,
      outputBytesCap: options.maxOutputBytes,
      processId: options.processId,
      streamStdoutStderr: true,
    }),
  };
}

export { withClient as withCodexClient };

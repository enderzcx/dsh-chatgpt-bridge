/**
 * Async command execution over the codex app-server backend.
 *
 * The synchronous `dsh_run_command` blocks one MCP call until the command ends.
 * These entry points cover long work instead: start returns a `run_id`
 * immediately, output reads incrementally, and terminate stops exactly one run.
 * A run is started once — reading and terminating never re-launch it.
 *
 * Each run owns a dedicated app-server connection, created when the run starts
 * and closed when it finishes. That is what keeps runs isolated: one run's
 * `processId` namespace, stderr, and lifetime cannot collide with another's, and
 * a run that fails cannot take an unrelated run down.
 *
 * Termination is the one operation that uses a second connection: the app
 * server tracks a process by its `processId`, not by the socket that started it,
 * so a fresh connection can stop it. That is the mechanism the app-server
 * protocol provides; if it ever fails, the run and its connection are left to
 * finish rather than reporting a stop that did not happen.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { buildChildEnv, effectiveSandboxEnvelope, resolveCwd } from './exec.js';
import { buildCodexEnv } from './secrets.js';
import { planCodexSandbox } from './codex-backend.js';
import { CodexAppServerClient } from './codex-app-server.js';
import { resolveAllowedCommand } from './policy.js';
import { RunRegistry, type RunView } from './exec-runs.js';
import { DirectOpsError, type DirectOpsPolicy } from './types.js';

/** Per-policy registries, so a reload cannot orphan or mix live runs. */
const registries = new WeakMap<DirectOpsPolicy, RunRegistry>();

function registryOf(policy: DirectOpsPolicy): RunRegistry {
  const existing = registries.get(policy);
  if (existing !== undefined) return existing;
  const created = new RunRegistry({
    maxRuns: policy.exec.asyncMaxRuns,
    maxOutputBytes: policy.exec.asyncMaxOutputBytes,
  });
  registries.set(policy, created);
  return created;
}

export interface StartRunInput {
  cmd: string;
  args?: string[];
  cwd?: string;
  timeout_ms?: number;
  max_output_bytes?: number;
  env?: Record<string, string>;
}

/**
 * Start one allowlisted command as an async run and return immediately.
 *
 * Only the codex backend supports async runs: the Seatbelt path has no way to
 * stream or terminate a child after the MCP call returns, so asking for it there
 * is an explicit refusal rather than a silent downgrade to synchronous work.
 */
export async function startCommand(input: StartRunInput, policy: DirectOpsPolicy): Promise<RunView> {
  if (!policy.enabled) {
    throw new DirectOpsError('DIRECT_OPS_DISABLED', 'direct operations are disabled by the host configuration');
  }
  if (!policy.exec.enabled) {
    throw new DirectOpsError('EXEC_DISABLED', 'direct command execution is disabled by the host configuration');
  }
  if (policy.exec.backend !== 'codex-app-server') {
    throw new DirectOpsError(
      'ASYNC_UNSUPPORTED_BACKEND',
      `async runs require exec.backend="codex-app-server" (currently ${JSON.stringify(policy.exec.backend)}); the `
        + 'local sandbox-exec path cannot stream or terminate a command after the call returns, and this surface '
        + 'will not pretend to.',
      { backend: policy.exec.backend },
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
  const args = (input.args ?? []).map((item) => String(item));
  const childEnv = buildChildEnv(policy, input.env);
  // Resolve the allowlist and the sandbox plan before anything is started, so a
  // refusal happens before a process exists.
  const { path: binary } = resolveAllowedCommand(input.cmd, policy);
  const plan = planCodexSandbox(policy, cwd);
  const processId = `dsh-${randomUUID()}`;

  return registryOf(policy).start({
    cmd: input.cmd,
    argv: [input.cmd, ...args],
    cwd,
    backend: 'codex-app-server',
    // The same effective envelope the synchronous path publishes, so
    // dsh_read_command_output and dsh_run_command are directly comparable.
    sandbox: effectiveSandboxEnvelope({
      kind: 'codex-app-server',
      applied: plan.describe.sandboxed !== false,
      fullAccess: policy.exec.fullAccess,
      configured: {
        network: policy.exec.network,
        filesystem: policy.exec.filesystem,
        writableRoots: policy.exec.writableRoots,
      },
      extra: {
        codex_policy: String(plan.describe.codex_policy ?? ''),
        ...(plan.describe.note === undefined ? {} : { note: String(plan.describe.note) }),
        ...(plan.describe.read_scope === undefined ? {} : { read_scope: String(plan.describe.read_scope) }),
        ...(plan.describe.write_scope === undefined ? {} : { write_scope: String(plan.describe.write_scope) }),
      },
    }),
    processId,
    maxOutputBytes: maxOutput,
    run: (onDelta) => {
      // The client is created here and handed to the registry, so the run can
      // stop its own process on the one connection that owns the process id.
      const client = createClient(policy, onDelta);
      const ready = client.start();
      const result = ready.then(() => client.exec({
        command: [binary, ...args],
        cwd,
        env: childEnv,
        sandboxPolicy: plan.policy,
        timeoutMs,
        outputBytesCap: maxOutput,
        processId,
        streamStdoutStderr: true,
      }));
      return {
        result,
        stop: () => client.terminate(processId),
        dispose: () => client.close(),
      };
    },
  });
}

/** Build one dedicated app-server client for a run. */
function createClient(
  policy: DirectOpsPolicy,
  onDelta: (stream: 'stdout' | 'stderr', text: string, capReached: boolean) => void,
): CodexAppServerClient {
  const binPath = policy.exec.codexBin;
  if (binPath === undefined || binPath.trim() === '') {
    throw new DirectOpsError(
      'CODEX_BIN_UNCONFIGURED',
      'exec.backend is "codex-app-server" but exec.codexBin is not set; a local administrator must name the '
        + 'codex executable. The bridge never guesses it from PATH.',
      { backend: policy.exec.backend },
    );
  }
  if (policy.exec.codexHome !== undefined && policy.exec.codexHome !== '') {
    mkdirSync(policy.exec.codexHome, { recursive: true, mode: 0o700 });
  }
  return new CodexAppServerClient({
    binPath,
    binArgs: policy.exec.codexArgs,
    // Same isolated environment as the synchronous path: without this the child
    // would read the user's global ~/.codex/config.toml, and the async path is
    // reachable in restricted mode too. `buildChildEnv` is for the CHILD of a
    // command; the app-server itself needs the codex environment.
    env: buildCodexEnv(policy),
    onOutputDelta: (delta) => onDelta(delta.stream, delta.text, delta.capReached),
  });
}

/** Read one run's output, optionally only what arrived after `since_seq`. */
export function readRun(runId: string, sinceSeq: number | undefined, policy: DirectOpsPolicy): RunView {
  const seq = sinceSeq !== undefined && sinceSeq > 0 ? Math.trunc(sinceSeq) : 0;
  return registryOf(policy).view(runId, seq);
}

/**
 * Terminate one async run and report only what was confirmed.
 *
 * The stop request goes over the run's own connection (the app server scopes a
 * `processId` to its connection). The run is then waited on: `terminated` is
 * true only once the process has actually exited. If the stop cannot be
 * confirmed, the run keeps its `running` status so the concurrency slot is not
 * handed out while a process is still alive, and the caller is told the
 * confirmation is outstanding.
 */
export async function terminateRun(
  runId: string,
  policy: DirectOpsPolicy,
): Promise<RunView & { terminated: boolean; confirmation: 'exited' | 'not_running' | 'unconfirmed' }> {
  const registry = registryOf(policy);
  const run = registry.get(runId);
  if (run.status !== 'running' || run.stop === undefined) {
    return { ...registry.view(runId, 0), terminated: false, confirmation: 'not_running' };
  }
  registry.markStopRequested(runId);
  let stopAccepted = false;
  let stopError: unknown;
  try {
    await run.stop();
    stopAccepted = true;
  } catch (error) {
    stopError = error;
  }
  // Wait for the process itself, not for the stop call, before claiming anything.
  const settled = await registry.awaitSettled(runId, TERMINATE_CONFIRM_MS);
  if (settled.status === 'running') {
    // The stop was accepted but the process has not exited yet. Report that
    // honestly instead of marking it terminated and freeing its slot.
    return {
      ...registry.view(runId, 0),
      terminated: false,
      confirmation: 'unconfirmed',
      ...(stopAccepted ? {} : { error: stopError instanceof Error ? stopError.message : String(stopError) }),
    };
  }
  registry.markTerminated(runId);
  await settled.promise.catch(() => undefined);
  return { ...registry.view(runId, 0), terminated: true, confirmation: 'exited' };
}

/** How long a stop is allowed to take before it is reported as unconfirmed. */
const TERMINATE_CONFIRM_MS = 10000;

/** Whether this policy can serve async runs at all, for policy self-description. */
export function asyncRunsSupported(policy: DirectOpsPolicy): boolean {
  return policy.exec.backend === 'codex-app-server';
}

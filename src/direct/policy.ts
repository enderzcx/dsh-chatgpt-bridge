/**
 * Direct-operation policy: the single source of authorization for the direct
 * surface. Roots, write/exec enablement and limits all come from here.
 *
 * There is deliberately NO tool argument that can widen this policy. A caller
 * cannot pass `allowed_roots`, `approved: true`, or a cwd that silently becomes
 * a root; only this resolved configuration decides what is reachable.
 *
 * Two sources, in order:
 *   1. the plugin row config under `directOps` (trusted host config);
 *   2. when `policyFile` is set, a JSON document re-read by
 *      `dsh_operator_reload_policy`, so enabling exec or adding a root does not
 *      require restarting the DSH process that currently carries the tunnel.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DEFAULT_DENIED_BASENAMES, DEFAULT_DENIED_SEGMENTS } from './secrets.js';
import {
  DirectOpsError,
  type DirectOpsExecPolicy,
  type DirectOpsLimits,
  type DirectOpsPolicy,
  type DirectOpsRoot,
} from './types.js';

/** Raw host-supplied config, validated structurally before it becomes a policy. */
export interface DirectOpsConfigInput {
  enabled?: boolean;
  allowWrites?: boolean;
  roots?: string[];
  writableRoots?: string[];
  policyFile?: string;
  deniedNames?: string[];
  limits?: Partial<DirectOpsLimits>;
  exec?: {
    enabled?: boolean;
    allowedCommands?: string[];
    cwdRoots?: string[];
    /** Paths the child may WRITE. Independent of cwd; empty means no writes. */
    writableRoots?: string[];
    network?: 'deny' | 'allow';
    filesystem?: 'roots' | 'inherit';
    sandbox?: 'required' | 'preferred';
    envPassthrough?: string[];
    pathEntries?: string[];
    /** Local execution backend; see {@link DirectOpsExecPolicy.backend}. */
    backend?: 'sandbox-exec' | 'codex-app-server';
    /** Absolute path to the codex executable for the app-server backend. */
    codexBin?: string;
    codexArgs?: string[];
    /** Isolated CODEX_HOME for the app-server child; see DirectOpsExecPolicy. */
    codexHome?: string;
    /**
     * Administrator-only full access; see {@link DirectOpsExecPolicy.fullAccess}.
     * Defaults to false, and only this trusted config can enable it.
     */
    fullAccess?: boolean;
    asyncMaxOutputBytes?: number;
    asyncMaxRuns?: number;
  };
}

export const DEFAULT_DIRECT_LIMITS: DirectOpsLimits = {
  readMaxBytes: 262144,
  readMaxLines: 2000,
  readMaxWindowBytes: 8 * 1024 * 1024,
  writeMaxBytes: 1048576,
  execMaxOutputBytes: 262144,
  execTimeoutMs: 30000,
  execMaxTimeoutMs: 600000,
};

export const DEFAULT_EXEC_POLICY: DirectOpsExecPolicy = {
  enabled: false,
  allowedCommands: [],
  cwdRoots: [],
  writableRoots: [],
  network: 'deny',
  filesystem: 'roots',
  // "required" is the default: when no OS sandbox can enforce the configured
  // read/write/network boundary, the command is refused rather than run bare.
  sandbox: 'required',
  envPassthrough: ['PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM'],
  pathEntries: [],
  backend: 'sandbox-exec',
  fullAccess: false,
  // Empty string means unset. This mirrors the public schema, which cannot carry
  // `undefined` through its defaults, and the resolution code treats both the same.
  codexBin: '',
  codexHome: '',
  codexArgs: [],
  asyncMaxOutputBytes: 262144,
  asyncMaxRuns: 4,
};

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const SANDBOX_APPLICABLE = process.platform === 'darwin';
const SANDBOX_TTL_MS = 30000;

let sandboxCache: { at: number; available: boolean } | undefined;

/**
 * Report whether an OS-level sandbox is available. Cached briefly because it
 * stats a binary on every exec call, but never cached as `true` when missing.
 */
export function sandboxExecAvailable(now = Date.now()): boolean {
  if (!SANDBOX_APPLICABLE) return false;
  if (sandboxCache !== undefined && now - sandboxCache.at < SANDBOX_TTL_MS) return sandboxCache.available;
  let available = false;
  try {
    available = existsSync(SANDBOX_EXEC) && statSync(SANDBOX_EXEC).isFile();
  } catch {
    available = false;
  }
  sandboxCache = { at: now, available };
  return available;
}

export function sandboxKind(): string {
  if (!SANDBOX_APPLICABLE) return 'none';
  return sandboxExecAvailable() ? 'macos-sandbox-exec' : 'none';
}

/**
 * Validate the administrator-only full-access switch.
 *
 * Only a literal `true` enables it; anything else (including a string) is a
 * configuration error rather than a silent coercion.
 */
function fullAccessOf(value: unknown): boolean {
  if (value === undefined) return DEFAULT_EXEC_POLICY.fullAccess;
  if (value === true || value === false) return value;
  throw new DirectOpsError(
    'INVALID_ARGUMENT',
    'exec.fullAccess must be a boolean; it is an administrator-only switch and is never inferred from a string',
    { fullAccess: value },
  );
}

/** Validate the configured exec backend, defaulting to the local sandbox plan. */
function execBackend(value: unknown): 'sandbox-exec' | 'codex-app-server' {
  if (value === undefined) return DEFAULT_EXEC_POLICY.backend;
  if (value === 'sandbox-exec' || value === 'codex-app-server') return value;
  throw new DirectOpsError(
    'INVALID_ARGUMENT',
    'exec.backend must be "sandbox-exec" or "codex-app-server"',
    { backend: value },
  );
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function assertNonEmptyStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new DirectOpsError('INVALID_ARGUMENT', `${label} must be an array of non-empty strings`);
  }
  return value.map((item) => (item as string).trim());
}

function positiveInt(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new DirectOpsError('INVALID_ARGUMENT', `${label} must be a positive integer`);
  }
  return value;
}

function buildRoots(configured: string[], writable: string[]): DirectOpsRoot[] {
  const writableSet = new Set(writable.map((item) => resolve(item)));
  const seen = new Set<string>();
  const roots: DirectOpsRoot[] = [];
  for (const raw of configured) {
    const absolute = resolve(raw);
    if (!isAbsolute(absolute)) {
      throw new DirectOpsError('INVALID_ARGUMENT', `root must be an absolute path: ${raw}`);
    }
    if (!existsSync(absolute)) {
      // A missing root is a config error, not a reason to silently drop it:
      // silently dropping would make an empty root list look like "allowed".
      throw new DirectOpsError('INVALID_ARGUMENT', `trusted root does not exist: ${raw}`);
    }
    let real: string;
    try {
      real = realpathSync.native(absolute);
    } catch {
      throw new DirectOpsError('INVALID_ARGUMENT', `trusted root could not be canonicalized: ${raw}`);
    }
    if (!statSync(real).isDirectory()) {
      throw new DirectOpsError('INVALID_ARGUMENT', `trusted root is not a directory: ${raw}`);
    }
    if (seen.has(real)) continue;
    seen.add(real);
    roots.push({
      path: absolute,
      real,
      label: real,
      writable: writableSet.has(absolute) || writableSet.has(real),
    });
  }
  return roots;
}

/** Read and JSON-parse the trusted policy file, if configured. */
export function readPolicyFile(path: string): DirectOpsConfigInput {
  const absolute = resolve(path);
  let raw: string;
  try {
    raw = readFileSync(absolute, 'utf8');
  } catch {
    throw new DirectOpsError('INVALID_ARGUMENT', 'direct-ops policy file could not be read', {
      path: absolute,
    });
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('policy file must contain a JSON object');
    }
    return parsed as DirectOpsConfigInput;
  } catch (error) {
    throw new DirectOpsError('INVALID_ARGUMENT', `direct-ops policy file is not valid JSON: ${(error as Error).message}`, {
      path: absolute,
    });
  }
}

/**
 * Resolve the effective direct-ops policy. `fileConfig` wins over `rowConfig`
 * so the host can keep sensitive roots out of the plugin row.
 */
export function resolveDirectOpsPolicy(row: DirectOpsConfigInput, explicitFileConfig?: DirectOpsConfigInput): DirectOpsPolicy {
  const fromFile = explicitFileConfig
    ?? (row.policyFile !== undefined && row.policyFile !== ''
      ? readPolicyFile(row.policyFile)
      : undefined);
  const merged: DirectOpsConfigInput = { ...row, ...(fromFile ?? {}) };
  const limits: DirectOpsLimits = {
    readMaxBytes: positiveInt(merged.limits?.readMaxBytes, 'limits.readMaxBytes', DEFAULT_DIRECT_LIMITS.readMaxBytes),
    readMaxLines: positiveInt(merged.limits?.readMaxLines, 'limits.readMaxLines', DEFAULT_DIRECT_LIMITS.readMaxLines),
    readMaxWindowBytes: positiveInt(
      merged.limits?.readMaxWindowBytes,
      'limits.readMaxWindowBytes',
      DEFAULT_DIRECT_LIMITS.readMaxWindowBytes,
    ),
    writeMaxBytes: positiveInt(merged.limits?.writeMaxBytes, 'limits.writeMaxBytes', DEFAULT_DIRECT_LIMITS.writeMaxBytes),
    execMaxOutputBytes: positiveInt(
      merged.limits?.execMaxOutputBytes,
      'limits.execMaxOutputBytes',
      DEFAULT_DIRECT_LIMITS.execMaxOutputBytes,
    ),
    execTimeoutMs: positiveInt(merged.limits?.execTimeoutMs, 'limits.execTimeoutMs', DEFAULT_DIRECT_LIMITS.execTimeoutMs),
    execMaxTimeoutMs: positiveInt(
      merged.limits?.execMaxTimeoutMs,
      'limits.execMaxTimeoutMs',
      DEFAULT_DIRECT_LIMITS.execMaxTimeoutMs,
    ),
  };
  if (limits.execTimeoutMs > limits.execMaxTimeoutMs) {
    throw new DirectOpsError('INVALID_ARGUMENT', 'limits.execTimeoutMs must not exceed limits.execMaxTimeoutMs');
  }

  const configuredRoots = assertNonEmptyStringArray(merged.roots, 'roots');
  const configuredWritable = assertNonEmptyStringArray(merged.writableRoots, 'writableRoots');

  // There is NO home fallback and no implicit root. An empty or missing root
  // list means the direct surface is closed. Falling back to $HOME would turn a
  // missing configuration into "the whole home directory is readable", which is
  // exactly the failure mode this surface must not have.
  const roots = buildRoots(configuredRoots, configuredWritable);
  const writableLabels = roots.filter((root) => root.writable).map((root) => root.real);
  const readLabels = roots.map((root) => root.real);
  const writesEnabled = merged.allowWrites === true && writableLabels.length > 0;

  const execInput = merged.exec ?? {};
  if (execInput.network !== undefined && execInput.network !== 'deny' && execInput.network !== 'allow') {
    throw new DirectOpsError('INVALID_ARGUMENT', 'exec.network must be "deny" or "allow"');
  }
  if (execInput.filesystem !== undefined && execInput.filesystem !== 'roots' && execInput.filesystem !== 'inherit') {
    throw new DirectOpsError('INVALID_ARGUMENT', 'exec.filesystem must be "roots" or "inherit"');
  }
  if (execInput.sandbox !== undefined && execInput.sandbox !== 'required' && execInput.sandbox !== 'preferred') {
    throw new DirectOpsError('INVALID_ARGUMENT', 'exec.sandbox must be "required" or "preferred"');
  }
  const cwdRoots = assertNonEmptyStringArray(execInput.cwdRoots, 'exec.cwdRoots');
  const allowedCommands = assertNonEmptyStringArray(execInput.allowedCommands, 'exec.allowedCommands');
  const envPassthrough = assertNonEmptyStringArray(execInput.envPassthrough, 'exec.envPassthrough');
  const execEnabled = execInput.enabled === true;
  const fullAccess = fullAccessOf(execInput.fullAccess);
  const backend = execBackend(execInput.backend);
  if (execEnabled && allowedCommands.length === 0 && !fullAccess) {
    throw new DirectOpsError(
      'INVALID_ARGUMENT',
      'exec.enabled requires a non-empty exec.allowedCommands allowlist; there is no "any command" mode. '
        + 'Administrator full access (exec.fullAccess=true) is the only way to run arbitrary executable names.',
    );
  }
  if (fullAccess && backend !== 'codex-app-server') {
    // The local sandbox-exec plan always writes a confinement profile, so it
    // cannot honestly deliver full access. Refusing beats running it with the
    // allowlist and cwd lifted while still calling itself sandboxed.
    throw new DirectOpsError(
      'INVALID_ARGUMENT',
      'exec.fullAccess=true requires exec.backend="codex-app-server": the local sandbox-exec backend always writes '
        + 'a confinement profile, so it cannot provide unconfined execution. Set the codex backend, or leave '
        + 'full access off.',
      { backend, fullAccess: true },
    );
  }
  if (fullAccess && !execEnabled) {
    throw new DirectOpsError(
      'INVALID_ARGUMENT',
      'exec.fullAccess=true has no effect while exec.enabled is false; enable exec or clear full access',
      { fullAccess: true },
    );
  }

  // A cwd only decides where relative paths resolve. It never grants writes:
  // the write allow-list is exec.writableRoots (its own switch), or the roots
  // explicitly marked writable when the host enabled writes at all.
  const execWriteRoots = merged.exec?.writableRoots === undefined
    ? (writesEnabled ? writableLabels : [])
    : assertNonEmptyStringArray(merged.exec.writableRoots, 'exec.writableRoots').map((item) => resolve(item));
  for (const path of execWriteRoots) {
    if (!readLabels.includes(path) && !writableLabels.includes(path)) {
      throw new DirectOpsError(
        'INVALID_ARGUMENT',
        `exec.writableRoots entries must also appear in directOps.roots (or writableRoots): ${path}`,
      );
    }
  }

  const deniedNames = merged.deniedNames === undefined
    ? DEFAULT_DENIED_SEGMENTS
    : DEFAULT_DENIED_SEGMENTS.concat(assertNonEmptyStringArray(merged.deniedNames, 'deniedNames'));

  // A policy/control file inside a writable root would let the very tools it
  // governs rewrite their own permissions. We do not modify the user's config;
  // instead the file (and, when it lives inside a writable root, its directory)
  // is refused for every direct operation and denied inside the OS sandbox.
  const policyFilePath = row.policyFile !== undefined && row.policyFile !== '' ? resolve(row.policyFile) : undefined;
  const policyFileReal = policyFilePath === undefined ? undefined : realpathOrSelf(policyFilePath);
  const protectedPaths: string[] = [];
  if (policyFileReal !== undefined) {
    protectedPaths.push(policyFileReal);
    const insideWritable = roots.some(
      (root) => root.writable && (policyFileReal === root.real || policyFileReal.startsWith(`${root.real}/`)),
    );
    if (insideWritable) {
      const dir = dirname(policyFileReal);
      if (dir !== '/' && dir !== '') protectedPaths.push(dir);
    }
  }

  // exec.cwdRoots must be real directories inside the trusted roots. A raw string
  // list was previously passed straight through, so an unwritable cwd could be
  // configured and silently used.
  // Default to the WRITABLE labels, which is the historical behaviour. Defaulting
  // to every read root would silently widen where commands may run for every
  // existing configuration that never set exec.cwdRoots.
  const requestedCwdRoots = cwdRoots.length > 0
    ? cwdRoots.map((item) => resolve(item))
    : (writableLabels.length > 0 ? writableLabels : readLabels);
  const validatedCwdRoots: string[] = [];
  for (const candidate of requestedCwdRoots) {
    const match = roots.find((root) => candidate === root.real || candidate.startsWith(`${root.real}/`));
    if (match === undefined) {
      throw new DirectOpsError(
        'INVALID_ARGUMENT',
        `exec.cwdRoots entries must be inside a trusted root: ${candidate}`,
        { roots: roots.map((root) => root.real) },
      );
    }
    if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
      throw new DirectOpsError('INVALID_ARGUMENT', `exec.cwdRoots entry is not an existing directory: ${candidate}`);
    }
    const real = realpathOrSelf(candidate);
    if (!validatedCwdRoots.includes(real)) validatedCwdRoots.push(real);
  }

  return {
    enabled: merged.enabled === true && roots.length > 0,
    writesEnabled,
    roots,
    limits,
    exec: {
      enabled: execEnabled,
      allowedCommands,
      cwdRoots: validatedCwdRoots,
      writableRoots: writesEnabled ? execWriteRoots : [],
      network: execInput.network ?? DEFAULT_EXEC_POLICY.network,
      filesystem: execInput.filesystem ?? DEFAULT_EXEC_POLICY.filesystem,
      sandbox: execInput.sandbox ?? DEFAULT_EXEC_POLICY.sandbox,
      envPassthrough: envPassthrough.length > 0 ? envPassthrough : DEFAULT_EXEC_POLICY.envPassthrough,
      pathEntries: assertNonEmptyStringArray(execInput.pathEntries, 'exec.pathEntries'),
      backend,
      codexBin: execInput.codexBin === undefined || execInput.codexBin === '' ? '' : resolve(execInput.codexBin),
      codexArgs: assertNonEmptyStringArray(execInput.codexArgs, 'exec.codexArgs'),
      codexHome: execInput.codexHome === undefined || execInput.codexHome === '' ? '' : resolve(execInput.codexHome),
      asyncMaxOutputBytes: positiveInt(
        merged.limits?.execMaxOutputBytes ?? undefined,
        'limits.execMaxOutputBytes',
        DEFAULT_EXEC_POLICY.asyncMaxOutputBytes,
      ),
      asyncMaxRuns: positiveInt(execInput.asyncMaxRuns, 'exec.asyncMaxRuns', DEFAULT_EXEC_POLICY.asyncMaxRuns),
      // Trusted configuration only; a truthy non-boolean is rejected rather than
      // coerced, so a caller-supplied string can never switch this on.
      fullAccess,
    },
    policyReloadable: row.policyFile !== undefined && row.policyFile !== '',
    ...(row.policyFile === undefined || row.policyFile === '' ? {} : { policyFile: resolve(row.policyFile) }),
    configuredRoots,
    deniedNames,
    deniedBasenames: DEFAULT_DENIED_BASENAMES,
    ...(policyFileReal === undefined ? {} : { policyFileReal }),
    protectedPaths,
  };
}

/** Resolve a command name against the allowlist, returning the absolute path to run. */
export function resolveAllowedCommand(
  cmd: string,
  policy: DirectOpsPolicy,
): { path: string; usedPath: boolean } {
  if (typeof cmd !== 'string' || cmd.trim() === '') {
    throw new DirectOpsError('INVALID_ARGUMENT', 'cmd must be a non-empty string');
  }
  if (cmd.includes('/') || cmd.includes('\0')) {
    throw new DirectOpsError('INVALID_ARGUMENT', 'cmd must be a bare executable name, not a path');
  }
  const allowed = policy.exec.allowedCommands;
  // In administrator full-access mode the name allowlist is bypassed, so any
  // bare executable name resolves on PATH. The bare-name rule above still holds:
  // a caller still cannot hand over a path or an argv of its own choosing.
  if (!policy.exec.fullAccess && !allowed.includes(cmd)) {
    throw new DirectOpsError('COMMAND_NOT_ALLOWED', 'command is not in the server-side allowlist', {
      cmd,
      allowed_commands: allowed,
    });
  }
  // Search PATH only — never let the caller pick a binary by path.
  const searchPath = (process.env.PATH ?? '').split(':')
    .filter((entry) => entry !== '')
    .concat(policy.exec.pathEntries.filter((entry) => isAbsolute(entry)));
  for (const dir of searchPath) {
    const candidate = resolve(dir, cmd);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return { path: candidate, usedPath: true };
    } catch {
      // keep searching
    }
  }
  throw new DirectOpsError('SPAWN_FAILED', 'allowed command was not found on PATH', { cmd });
}

/**
 * Directories that hold USER DATA. The OS sandbox denies reading these outright
 * and then re-allows the explicitly configured roots, which is what makes
 * `filesystem: "roots"` a real read boundary instead of a write-only hint.
 *
 * A blanket request to allow `literal "/"` looks equivalent to the write denies
 * but is not: `/` is needed by the dynamic loader and a literal allow there opens
 * the whole disk. Denying the data trees keeps the loader working while cutting
 * user data off, and it makes the trade-off legible: system locations stay
 * readable because they are not the user's data, while everything under these
 * trees is denied until a root is mounted.
 */
const USER_DATA_DENY_TREES = ['/Users', '/Volumes', '/private/tmp', '/tmp', '/private/var/folders'];

/**
 * Privilege and credential locations outside the data trees that must stay
 * unreadable even though they are nominally system data.
 */
const READ_DENY_ALWAYS = [
  '/private/etc/ssh',
  '/private/etc/sudoers',
  '/private/etc/sudoers.d',
  '/private/etc/master.passwd',
  '/private/etc/pam.d',
  '/private/etc/ssl/private',
];

/** Device nodes a process needs to write; everything else is denied. */
const WRITE_DEVICE_ALLOW = ['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/dtracehelper', '/dev/tty'];

/** True when `path` is inside (or equal to) one of the user data trees. */
export function isUnderUserDataTree(path: string): boolean {
  return USER_DATA_DENY_TREES.some((tree) => path === tree || path.startsWith(`${tree}/`));
}

/**
 * Process-exec entries that are not file paths: the canonical shells, so a
 * command that re-execs a shell still starts. Each entry must be a *complete*
 * filter form — the sandbox language rejects a bare `literal "..."` with
 * "illegal argument", which fails the whole profile closed.
 */
const PROCESS_EXEC_ALLOW = [
  '(literal "/bin/sh")',
  '(literal "/bin/bash")',
  '(literal "/bin/zsh")',
  '(literal "/usr/bin/env")',
];

/**
 * Build the sandbox-exec profile for one exec call.
 *
 * HONEST SCOPE — this is a denylist of user-data trees plus a write allow-list,
 * NOT a full read sandbox:
 *   - data reads are denied for USER_DATA_DENY_TREES and re-allowed for the
 *     trusted roots (plus the binary's own path), which stops a command from
 *     reading `~/.ssh`, other projects, or a sibling of a root;
 *   - everything else on the machine outside those trees stays readable;
 *   - writes are allowed only for `writableRoots`, never `cwd` by default.
 * A default-deny read profile (deny file-read* then allow subpaths) is NOT
 * equivalent: it aborts every child because the dynamic loader reads the volume
 * root, so it is not used here. Complete path isolation is deferred, which is
 * why `exec` remains disabled by default and is documented as a prototype.
 *
 * The profile uses canonical (realpath) paths because the sandbox matches real
 * paths — on macOS `/tmp` is `/private/tmp`.
 */
export function buildSandboxProfile(options: {
  policy: DirectOpsPolicy;
  cwd: string;
  binary: string;
  readableRoots: string[];
  writableRoots: string[];
  deniedReadPaths: string[];
}): string {
  const { policy, cwd, binary, readableRoots, writableRoots, deniedReadPaths } = options;
  const lines = ['(version 1)', '(allow default)'];
  for (const entry of PROCESS_EXEC_ALLOW) lines.push(`(allow process-exec ${entry})`);
  if (binary !== '') lines.push(`(allow process-exec (literal ${JSON.stringify(binary)}))`);
  if (policy.exec.network === 'deny') lines.push('(deny network*)');

  if (policy.exec.filesystem === 'roots') {
    // Deny user data, then re-allow exactly the configured roots. Order matters:
    // a later allow reopens what an earlier deny closed, which is precisely why
    // the roots are re-allowed last and the policy file is denied after them.
    for (const tree of USER_DATA_DENY_TREES) {
      lines.push(`(deny file-read-data (subpath ${JSON.stringify(tree)}))`);
    }
    for (const path of READ_DENY_ALWAYS) {
      lines.push(`(deny file-read-data (subpath ${JSON.stringify(path)}))`);
    }
    for (const path of new Set([...readableRoots, ...writableRoots, cwd])) {
      if (path === '') continue;
      lines.push(`(allow file-read-data (subpath ${JSON.stringify(path)}))`);
    }
    // A root mounted inside a system temp tree is already re-allowed above by its
    // own subpath. The tree itself must NOT be reopened: doing so would make every
    // sibling temp directory readable again, which is exactly the escape this
    // deny-then-allow order exists to prevent.
    // Path metadata stays readable so absolute-path resolution works; only DATA
    // reads are constrained. Denying metadata makes dyld abort every child.
    lines.push('(allow file-read-metadata)');

    // Writes: denied by default, allowed only for the configured write roots.
    lines.push('(deny file-write*)');
    for (const path of new Set(writableRoots)) {
      lines.push(`(allow file-write* (subpath ${JSON.stringify(path)}))`);
    }
    for (const device of WRITE_DEVICE_ALLOW) {
      lines.push(`(allow file-write* (literal ${JSON.stringify(device)}))`);
    }

    // Denies come last so they win over every allow above: the policy file and
    // any path the policy itself refuses are closed for read and write even when
    // they sit inside an allowed root.
    for (const path of new Set(deniedReadPaths)) {
      if (path === '') continue;
      lines.push(`(deny file-read-data (subpath ${JSON.stringify(path)}))`);
      lines.push(`(deny file-write* (subpath ${JSON.stringify(path)}))`);
    }
  }
  return lines.join('');
}

/** True when at least one sandbox layer is actually requested. */
export function sandboxLayerRequested(policy: DirectOpsPolicy): boolean {
  return policy.exec.network === 'deny' || policy.exec.filesystem === 'roots';
}

/** Verify a sandbox is usable, or fail closed when it is required. */
export function assertSandboxAvailable(policy: DirectOpsPolicy): boolean {
  const requested = sandboxLayerRequested(policy);
  if (!requested) return false;
  if (sandboxExecAvailable()) return true;
  if (policy.exec.sandbox === 'required') {
    throw new DirectOpsError(
      'SANDBOX_UNAVAILABLE',
      'exec.sandbox is "required" but no OS sandbox is available on this host; refusing to run the command '
        + 'unsandboxed. Set exec.sandbox to "preferred" only if you accept an unconfined child.',
      { platform: process.platform },
    );
  }
  return false;
}

/** Cheap self-description used by dsh_operator_roots. */
export function execFileVersion(): string {
  try {
    return execFileSync('/usr/bin/uname', ['-srm'], { encoding: 'utf8', timeout: 2000 }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Direct-operation MCP surface.
 *
 * These tools are deliberately NOT part of the agent-control tool family: they
 * bypass DSH sessions, agents, approvals and the model loop entirely, so a
 * "read this file" or "run this check" costs zero model reasoning and creates no
 * session. Authorization comes from the resolved trusted policy only.
 *
 * MCP annotations are honest on purpose:
 *   - reads ............ readOnlyHint: true,  idempotentHint: true
 *   - writes/edits ..... readOnlyHint: false, destructiveHint: true
 *   - exec ............. readOnlyHint: false, destructiveHint: true,
 *                        openWorldHint: true (it can reach the network and
 *                        mutate anything the OS sandbox does not confine)
 * A host that auto-approves read-only tools must not accidentally auto-approve
 * a file write or a shell command because the annotation was flattering.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { editTextFile, readTextFile, writeTextFile } from './files.js';
import { runCommand } from './exec.js';
import { readRun, startCommand, terminateRun } from './async-exec.js';
import {
  execFileVersion,
  resolveDirectOpsPolicy,
  sandboxKind,
  type DirectOpsConfigInput,
} from './policy.js';
import { scrubSecrets } from './secrets.js';
import { callDiagnostics } from '../diagnostics.js';
import {
  DirectOpsError,
  type DirectOpsPolicy,
  type DirectOpsPolicyView,
} from './types.js';

export interface DirectOpsRuntime {
  /** Current effective policy; replaced by dsh_operator_reload_policy. */
  policy(): DirectOpsPolicy;
  reload(): DirectOpsPolicy;
  /** True when the host configured a reloadable policy file. */
  readonly reloadable: boolean;
}

export function createDirectOpsRuntime(rowConfig: DirectOpsConfigInput): DirectOpsRuntime {
  let current = resolveDirectOpsPolicy(rowConfig);
  return {
    policy: () => current,
    reload: () => {
      current = resolveDirectOpsPolicy(rowConfig);
      return current;
    },
    reloadable: rowConfig.policyFile !== undefined && rowConfig.policyFile !== '',
  };
}

/**
 * The diagnostics block this read-only tool reports.
 *
 * Everything here is already allowlisted at write time, so it cannot carry
 * caller data, paths, arguments or error text. It is deliberately a bounded
 * snapshot: the ring is in memory and a restart starts a new window.
 */
function diagnosticsView(): DirectOpsPolicyView['diagnostics'] {
  const snapshot = callDiagnostics.snapshot(40);
  return {
    coverage: { ...snapshot.coverage },
    ...(snapshot.tool_surface === undefined ? {} : { tool_surface: { ...snapshot.tool_surface } }),
    recent: snapshot.records.map((record) => ({ ...record })),
  };
}

export function describePolicy(policy: DirectOpsPolicy, runtime: DirectOpsRuntime): DirectOpsPolicyView {
  const notes: string[] = [];
  if (!policy.exec.enabled) {
    notes.push(
      'command execution is OFF: it is a high-privilege capability a local administrator must enable explicitly',
    );
  } else if (policy.exec.fullAccess) {
    // Conditional from the start: this note must never claim a trusted-root
    // boundary at the same time as the full-access block says there is none.
    notes.push(
      'command execution is ON in administrator full-access mode: the child runs with the same OS user as DSH and '
        + 'NONE of the usual command limits apply — no command allowlist (any bare executable name resolves on '
        + 'PATH), no cwd-root confinement, no write-root confinement, no $TMPDIR or /tmp exclusion, and no network '
        + 'denial. It is not "sandboxed with wider roots"; there is no OS sandbox in force.',
    );
  } else {
    notes.push(
      'command execution is ON: the child runs with the same OS user as DSH. The trusted-root list is enforced for '
        + 'cwd and, when filesystem=roots, for writes by the OS sandbox. It is not a general sandbox for reads, '
        + 'environment or network unless network=deny is in effect.',
    );
  }
  if (!policy.writesEnabled) notes.push('direct writes are OFF: no trusted root is configured as writable');
  notes.push('roots are server-side configuration; no tool argument can add, widen or approve a root');

  // The command sandbox is reported from the backend that would actually run the
  // command. The codex backend confines with codex's own OS sandbox, so its
  // availability comes from having a configured executable — not from the
  // Seatbelt binary the other backend uses.
  const backend = policy.exec.backend;
  const codexConfigured = policy.exec.codexBin !== undefined && policy.exec.codexBin !== '';
  const full = policy.exec.fullAccess;

  if (backend === 'codex-app-server') {
    if (full) {
      // Say what is TRUE, not what is configured. The configured network/filesystem
      // values are not in force and are reported as separate fields below.
      notes.push(
        'ADMINISTRATOR FULL ACCESS IS ON: commands run with NO OS sandbox. The child may run any bare executable '
          + 'name, use any existing directory as its cwd, read and write anywhere the login user can, write to '
          + '$TMPDIR and /tmp, and use the network. codex is given dangerFullAccess.',
      );
      notes.push(
        'the configured network/filesystem values are NOT in force in this mode; they are reported as '
          + 'configured_* fields so they cannot be mistaken for the effective boundary',
      );
      notes.push('full access is selected only by trusted server-side configuration; no tool argument can enable it');
      notes.push('command results report applied=false, network=unconfined and filesystem=unconfined in this mode');
    } else {
      notes.push(
        codexConfigured
          ? 'commands run through a local codex app-server, which applies its own OS sandbox; no thread, turn or '
            + 'model call is created'
          : 'exec.backend is codex-app-server but exec.codexBin is unset: commands will be refused, not run unsandboxed',
      );
      if (policy.exec.enabled) {
        notes.push(
          policy.exec.writableRoots.length === 0
            ? 'command writes are OFF: exec.writableRoots is empty, so codex is given a readOnly policy'
            : 'command writes are limited to exec.writableRoots, which is a separate list from the file tools\' roots',
        );
        if (policy.exec.filesystem === 'roots') {
          notes.push(
            'codex readOnly/workspaceWrite permit host-wide READS; the trusted roots do NOT confine command reads, '
              + 'so do not read the file-tool root confinement as inherited here',
          );
        }
      }
      if (policy.exec.filesystem === 'inherit') {
        notes.push('exec.filesystem=inherit is refused by the codex backend rather than widened to full access');
      }
    }
  }
  if (backend === 'sandbox-exec' && full) {
    // Refused at resolution time, so this is unreachable in practice; kept so the
    // note set can never imply the mode took effect if the check is ever removed.
    notes.push('exec.fullAccess is not supported by the sandbox-exec backend and is refused at startup');
  }

  // Effective fields, consistent with the notes above.
  const effectiveNetwork = full ? 'unconfined' : policy.exec.network;
  const effectiveFilesystem = full ? 'unconfined' : policy.exec.filesystem;
  const sandboxKindValue = backend === 'codex-app-server'
    ? (full ? 'none' : (codexConfigured ? 'codex-app-server' : 'none'))
    : sandboxKind();

  return {
    enabled: policy.enabled,
    writes_enabled: policy.writesEnabled,
    exec_enabled: policy.exec.enabled,
    exec_sandbox: policy.exec.sandbox,
    exec_backend: backend,
    sandbox_available: policy.exec.enabled ? sandboxKindValue !== 'none' : false,
    sandbox_kind: sandboxKindValue,
    async_runs: policy.exec.enabled && backend === 'codex-app-server',
    command_writable_roots: full ? 'unconfined' : [...policy.exec.writableRoots],
    /**
     * Effective command-name policy. `any-on-path` means any bare executable name
     * resolves; `allowlist` means exec.allowedCommands applies.
     */
    command_policy: full ? 'any-on-path' : 'allowlist',
    /** The configured allowlist, kept for reference; NOT in force when command_policy=any-on-path. */
    configured_allowed_commands: [...policy.exec.allowedCommands],
    /** The configured cwd roots, kept for reference; NOT in force under full access. */
    configured_cwd_roots: [...policy.exec.cwdRoots],
    /** The EFFECTIVE sandbox demand, not the configured one. */
    exec_sandbox_effective: full ? 'none' : policy.exec.sandbox,
    network: effectiveNetwork,
    filesystem: effectiveFilesystem,
    ...(full ? { configured_network: policy.exec.network, configured_filesystem: policy.exec.filesystem } : {}),
    full_access: policy.exec.fullAccess,
    diagnostics: diagnosticsView(),
    roots: policy.roots.map((root) => ({ label: root.label, path: root.path, writable: root.writable })),
    allowed_commands: policy.exec.allowedCommands,
    limits: policy.limits,
    ...(policy.policyFile === undefined ? {} : { policy_file: policy.policyFile }),
    notes,
  };
}

function textResult(value: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  if (error instanceof DirectOpsError) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: {
            code: error.code,
            message: scrubSecrets(error.message),
            ...(error.details === undefined ? {} : { details: error.details }),
          },
        }, null, 2),
      }],
      isError: true,
    };
  }
  const message = scrubSecrets(error instanceof Error ? error.message : String(error));
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: { code: 'INTERNAL', message } }, null, 2) }],
    isError: true,
  };
}

function safe<A>(handler: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<{ content: { type: 'text'; text: string }[]; isError?: true }> => {
    try {
      return textResult(await handler(args));
    } catch (error) {
      return errorResult(error);
    }
  };
}

const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const EXEC_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/**
 * Reading a run's output is read-only. Terminating a run is described by
 * {@link EXEC_ANNOTATIONS} because it stops a process.
 */
const RUN_READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * Register the direct surface on an MCP server.
 *
 * Separate from the agent-control tools so the surface is visible and auditable
 * as one unit, and so a host can mount it on its own listener when a deployment
 * wants the direct surface reachable only on loopback.
 */
export function registerDirectOpsTools(server: McpServer, runtime: DirectOpsRuntime): void {
  server.registerTool(
    'dsh_read_text_file',
    {
      title: 'Read a local text file (no agent)',
      description:
        'Read a UTF-8 text file directly on the DSH host — no agent session and no model reasoning involved. '
        + 'Returns the requested line window plus a file_version whose sha256 covers exactly the bytes read, taken '
        + 'from the same read as the content (never a second open). Ranges are pageable: a later start_line buys a '
        + 'larger read window, so a big file is reachable up to the server read-window cap. Truncation is reported '
        + 'as line_range (page size) or byte_budget (read window reached), with line_count_complete. '
        + 'Paths must be inside a trusted root the host configured; absolute paths only.',
      inputSchema: z.object({
        path: z.string().min(1).describe('Absolute path inside a trusted root'),
        start_line: z.number().int().min(1).optional().describe('1-based first line (default 1)'),
        end_line: z.number().int().min(1).optional().describe('1-based last line (inclusive)'),
        max_bytes: z.number().int().min(1).optional().describe('Byte budget, capped by server configuration'),
      }),
      annotations: READ_ANNOTATIONS,
    },
    safe(async (args: { path: string; start_line?: number; end_line?: number; max_bytes?: number }) =>
      readTextFile(args, runtime.policy())),
  );

  server.registerTool(
    'dsh_write_text_file',
    {
      title: 'Create or replace a local text file (no agent)',
      description:
        'Write a UTF-8 text file directly on the DSH host — no agent session. mode=create is genuinely '
        + 'no-clobber (atomic link): it refuses to touch a file that exists, including one that appears while the '
        + 'call is in flight. mode=overwrite REQUIRES expected_sha256 from a read and fails closed with '
        + 'VERSION_CONFLICT if anything (a DSH agent, another tool, a build) changed the file in between — that is '
        + 'the guard against two writers overwriting each other. Replacement preserves the existing permission bits; '
        + 'new files are created 0600. Commits are atomic. Returns the new file_version.',
      inputSchema: z.object({
        path: z.string().min(1).describe('Absolute path inside a writable trusted root'),
        content: z.string().describe('Full new file content'),
        mode: z.enum(['create', 'overwrite']).optional()
          .describe('Default: create. create never touches an existing file; overwrite requires expected_sha256.'),
        expected_sha256: z.string().min(8).optional()
          .describe('file_version.sha256 from your last read. REQUIRED when overwriting an existing file; the write '
            + 'is refused with READ_REQUIRED otherwise. mode=create needs no version and never clobbers.'),
        create_dirs: z.boolean().optional().describe('Create missing parent directories (still inside the root)'),
      }),
      annotations: WRITE_ANNOTATIONS,
    },
    safe(async (args: {
      path: string;
      content: string;
      mode?: 'create' | 'overwrite';
      expected_sha256?: string;
      create_dirs?: boolean;
    }) => writeTextFile(args, runtime.policy())),
  );

  server.registerTool(
    'dsh_edit_text_file',
    {
      title: 'Edit a local text file by exact match (no agent)',
      description:
        'Apply a small exact-text edit directly on the DSH host — no agent session. old_text must match exactly '
        + '(including indentation); it is replaced LITERALLY, so $&, $1 and $$ in new_text stay literal text. If '
        + 'old_text occurs more than once the edit is refused unless replace_all=true. expected_sha256 is required '
        + 'and must come from a read of the current content: a concurrent change fails closed instead of clobbering '
        + 'an agent\'s work. A UTF-8 BOM is preserved. Returns the new file_version and the number of replacements.',
      inputSchema: z.object({
        path: z.string().min(1).describe('Absolute path inside a writable trusted root'),
        old_text: z.string().min(1).describe('Exact text to replace'),
        new_text: z.string().describe('Replacement text'),
        replace_all: z.boolean().optional().describe('Replace every occurrence (default false)'),
        expected_sha256: z.string().min(8).describe('file_version.sha256 from your last read; required, so a blind '
          + 'edit can never apply to a revision you did not see'),
        max_replacements: z.number().int().min(1).max(1000).optional().describe('Safety cap for replace_all'),
      }),
      annotations: WRITE_ANNOTATIONS,
    },
    safe(async (args: {
      path: string;
      old_text: string;
      new_text: string;
      replace_all?: boolean;
      expected_sha256?: string;
      max_replacements?: number;
    }) => editTextFile(args, runtime.policy())),
  );

  server.registerTool(
    'dsh_run_command',
    {
      title: 'Run an allowlisted command on the DSH host (no agent)',
      description:
        'Run one command directly on the DSH host — no agent session and no model reasoning. There is NO shell: '
        + 'pass cmd as a bare executable name from the server-side allowlist plus an argv array, so pipes, '
        + 'redirects and `;` are literal argument bytes rather than new commands. Returns exit_code, stdout, '
        + 'stderr, duration, explicit truncation flags, the backend that ran it, and the sandbox that was really '
        + 'applied. The sandbox is chosen by server-side configuration, never by an argument. Normally it confines '
        + 'writes to exec.writableRoots and can deny the network, but it is NOT full path isolation, and a '
        + 'file-tool root of / does not grant command writes. With exec.backend="codex-app-server" the command '
        + 'runs through a local codex app-server, which applies its own OS sandbox and creates no thread, turn or '
        + 'model call. If an administrator has enabled exec.fullAccess, the result says so plainly: applied=false, '
        + 'network=unconfined, filesystem=unconfined, any bare executable name resolves and the cwd may be any '
        + 'existing directory, because codex is given dangerFullAccess and no OS sandbox is in force. Disabled by '
        + 'default, and sandbox=required refuses to run at all when no OS sandbox is available, so a refusal is '
        + 'never silently downgraded to an unconfined run.',
      inputSchema: z.object({
        cmd: z.string().min(1).describe('Bare executable name from the host allowlist (no path, no shell)'),
        args: z.array(z.string()).optional().describe('Argument vector, passed literally'),
        cwd: z.string().optional().describe('Absolute working directory inside a trusted root'),
        timeout_ms: z.number().int().min(1).optional().describe('Kill after this many ms (capped by configuration)'),
        max_output_bytes: z.number().int().min(1).optional().describe('Per-stream capture budget'),
        env: z.record(z.string(), z.string()).optional()
          .describe('Extra environment variables; credential-shaped names are refused'),
      }),
      annotations: EXEC_ANNOTATIONS,
    },
    safe(async (args: {
      cmd: string;
      args?: string[];
      cwd?: string;
      timeout_ms?: number;
      max_output_bytes?: number;
      env?: Record<string, string>;
    }) => runCommand(args, runtime.policy())),
  );

  server.registerTool(
    'dsh_start_command',
    {
      title: 'Start a long command and return a run_id (no agent)',
      description:
        'Start one allowlisted command on the DSH host and return a run_id immediately instead of blocking on '
        + 'it — no agent session and no model reasoning. Requires the codex-app-server backend, because that is '
        + 'the only local path that can stream output and stop a process after this call returns. Output is read '
        + 'with dsh_read_command_output and stopped with dsh_terminate_command; the command is started exactly '
        + 'once. The returned sandbox describes what was really applied, and a caller cannot widen it.',
      inputSchema: z.object({
        cmd: z.string().min(1).describe('Bare executable name from the host allowlist (no path, no shell)'),
        args: z.array(z.string()).optional().describe('Argument vector, passed literally'),
        cwd: z.string().optional().describe('Absolute working directory inside a trusted root'),
        timeout_ms: z.number().int().min(1).optional().describe('Stop after this many ms (capped by configuration)'),
        max_output_bytes: z.number().int().min(1).optional().describe('Per-stream capture budget'),
        env: z.record(z.string(), z.string()).optional()
          .describe('Extra environment variables; credential-shaped names are refused'),
      }),
      annotations: EXEC_ANNOTATIONS,
    },
    safe(async (args: {
      cmd: string;
      args?: string[];
      cwd?: string;
      timeout_ms?: number;
      max_output_bytes?: number;
      env?: Record<string, string>;
    }) => startCommand(args, runtime.policy())),
  );

  server.registerTool(
    'dsh_read_command_output',
    {
      title: "Read a run's output by run_id (no agent)",
      description:
        'Read the accumulated stdout/stderr of one run started with dsh_start_command, plus its status, exit '
        + 'code and whether output was truncated. Pass since_seq from a previous read to receive only what '
        + 'arrived after it. Read-only: it never starts or restarts the command.',
      inputSchema: z.object({
        run_id: z.string().min(1),
        since_seq: z.number().int().min(0).optional()
          .describe('Return only chunks newer than this seq (from the previous read)'),
      }),
      annotations: RUN_READ_ANNOTATIONS,
    },
    safe(async (args: { run_id: string; since_seq?: number }) =>
      readRun(args.run_id, args.since_seq, runtime.policy())),
  );

  server.registerTool(
    'dsh_terminate_command',
    {
      title: 'Terminate one running command by run_id (no agent)',
      description:
        'Stop exactly one run started with dsh_start_command, using the codex app-server terminate call, and '
        + 'return its final state. A run that already exited reports terminated=false rather than pretending to '
        + 'have stopped something. Other runs are unaffected.',
      inputSchema: z.object({ run_id: z.string().min(1) }),
      annotations: EXEC_ANNOTATIONS,
    },
    safe(async (args: { run_id: string }) => terminateRun(args.run_id, runtime.policy())),
  );

  server.registerTool(
    'dsh_operator_roots',
    {
      title: 'Describe the direct-operation policy',
      description:
        'Read-only self-description of the direct surface: which trusted roots are mounted, whether writes and '
        + 'command execution are enabled, which commands are allowlisted, which sandbox layers are active, and the '
        + 'current limits. Use this before asking the user to enable something. It reports the policy; it cannot '
        + 'change it.',
      inputSchema: z.object({}),
      annotations: READ_ANNOTATIONS,
    },
    safe(async () => ({
      ...describePolicy(runtime.policy(), runtime),
      host: execFileVersion(),
    })),
  );

  server.registerTool(
    'dsh_operator_reload_policy',
    {
      title: 'Reload the direct-operation policy from its trusted file',
      description:
        'Re-read the admin-owned direct-ops policy file so a local administrator can enable command execution or '
        + 'mount a root without restarting DSH. Only re-reads a file path that the host configuration already '
        + 'named: this tool cannot point at a new file and cannot grant anything by itself. Fails closed if the '
        + 'file is missing or malformed (the previous policy stays in effect).',
      inputSchema: z.object({}),
      annotations: { ...WRITE_ANNOTATIONS, idempotentHint: true },
    },
    safe(async () => {
      if (!runtime.reloadable) {
        throw new DirectOpsError(
          'INVALID_ARGUMENT',
          'no directOps.policyFile is configured, so there is nothing to reload; set it in the plugin row config',
        );
      }
      const policy = runtime.reload();
      return { reloaded: true, policy: describePolicy(policy, runtime) };
    }),
  );
}

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
import { execFileVersion, resolveDirectOpsPolicy, sandboxKind, } from './policy.js';
import { scrubSecrets } from './secrets.js';
import { DirectOpsError, } from './types.js';
export function createDirectOpsRuntime(rowConfig) {
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
export function describePolicy(policy, runtime) {
    const notes = [];
    if (!policy.exec.enabled) {
        notes.push('command execution is OFF: it is a high-privilege capability a local administrator must enable explicitly');
    }
    else {
        notes.push('command execution is ON: the child runs with the same OS user as DSH. The trusted-root list is enforced for '
            + 'cwd and, when filesystem=roots, for writes by the OS sandbox. It is not a general sandbox for reads, '
            + 'environment or network unless network=deny is in effect.');
    }
    if (!policy.writesEnabled)
        notes.push('direct writes are OFF: no trusted root is configured as writable');
    notes.push('roots are server-side configuration; no tool argument can add, widen or approve a root');
    return {
        enabled: policy.enabled,
        writes_enabled: policy.writesEnabled,
        exec_enabled: policy.exec.enabled,
        exec_sandbox: policy.exec.sandbox,
        sandbox_available: policy.exec.enabled ? sandboxKind() !== 'none' : false,
        sandbox_kind: sandboxKind(),
        network: policy.exec.network,
        filesystem: policy.exec.filesystem,
        roots: policy.roots.map((root) => ({ label: root.label, path: root.path, writable: root.writable })),
        allowed_commands: policy.exec.allowedCommands,
        limits: policy.limits,
        ...(policy.policyFile === undefined ? {} : { policy_file: policy.policyFile }),
        notes,
    };
}
function textResult(value) {
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
function errorResult(error) {
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
function safe(handler) {
    return async (args) => {
        try {
            return textResult(await handler(args));
        }
        catch (error) {
            return errorResult(error);
        }
    };
}
const READ_ANNOTATIONS = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
};
const WRITE_ANNOTATIONS = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
};
const EXEC_ANNOTATIONS = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
};
/**
 * Register the direct surface on an MCP server.
 *
 * Separate from the agent-control tools so the surface is visible and auditable
 * as one unit, and so a host can mount it on its own listener when a deployment
 * wants the direct surface reachable only on loopback.
 */
export function registerDirectOpsTools(server, runtime) {
    server.registerTool('dsh_read_text_file', {
        title: 'Read a local text file (no agent)',
        description: 'Read a UTF-8 text file directly on the DSH host — no agent session and no model reasoning involved. '
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
    }, safe(async (args) => readTextFile(args, runtime.policy())));
    server.registerTool('dsh_write_text_file', {
        title: 'Create or replace a local text file (no agent)',
        description: 'Write a UTF-8 text file directly on the DSH host — no agent session. mode=create is genuinely '
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
    }, safe(async (args) => writeTextFile(args, runtime.policy())));
    server.registerTool('dsh_edit_text_file', {
        title: 'Edit a local text file by exact match (no agent)',
        description: 'Apply a small exact-text edit directly on the DSH host — no agent session. old_text must match exactly '
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
    }, safe(async (args) => editTextFile(args, runtime.policy())));
    server.registerTool('dsh_run_command', {
        title: 'Run an allowlisted command on the DSH host (no agent)',
        description: 'Run one command directly on the DSH host — no agent session and no model reasoning. There is NO shell: '
            + 'pass cmd as a bare executable name from the server-side allowlist plus an argv array, so pipes, '
            + 'redirects and `;` are literal argument bytes rather than new commands. Returns exit_code, stdout, '
            + 'stderr, duration, explicit truncation flags and whether the timeout killed the process group. '
            + 'PROTOTYPE, NOT APPROVED: the OS sandbox denies a set of user-data trees (so ~/.ssh and siblings of a '
            + 'root are refused), confines writes to exec.writableRoots, and can deny the network — but it is NOT full '
            + 'path isolation, and filesystem=roots must not be read as "confined to the trusted roots". Disabled by '
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
    }, safe(async (args) => runCommand(args, runtime.policy())));
    server.registerTool('dsh_operator_roots', {
        title: 'Describe the direct-operation policy',
        description: 'Read-only self-description of the direct surface: which trusted roots are mounted, whether writes and '
            + 'command execution are enabled, which commands are allowlisted, which sandbox layers are active, and the '
            + 'current limits. Use this before asking the user to enable something. It reports the policy; it cannot '
            + 'change it.',
        inputSchema: z.object({}),
        annotations: READ_ANNOTATIONS,
    }, safe(async () => ({
        ...describePolicy(runtime.policy(), runtime),
        host: execFileVersion(),
    })));
    server.registerTool('dsh_operator_reload_policy', {
        title: 'Reload the direct-operation policy from its trusted file',
        description: 'Re-read the admin-owned direct-ops policy file so a local administrator can enable command execution or '
            + 'mount a root without restarting DSH. Only re-reads a file path that the host configuration already '
            + 'named: this tool cannot point at a new file and cannot grant anything by itself. Fails closed if the '
            + 'file is missing or malformed (the previous policy stays in effect).',
        inputSchema: z.object({}),
        annotations: { ...WRITE_ANNOTATIONS, idempotentHint: true },
    }, safe(async () => {
        if (!runtime.reloadable) {
            throw new DirectOpsError('INVALID_ARGUMENT', 'no directOps.policyFile is configured, so there is nothing to reload; set it in the plugin row config');
        }
        const policy = runtime.reload();
        return { reloaded: true, policy: describePolicy(policy, runtime) };
    }));
}

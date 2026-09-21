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
import { type DirectOpsConfigInput } from './policy.js';
import { type DirectOpsPolicy, type DirectOpsPolicyView } from './types.js';
export interface DirectOpsRuntime {
    /** Current effective policy; replaced by dsh_operator_reload_policy. */
    policy(): DirectOpsPolicy;
    reload(): DirectOpsPolicy;
    /** True when the host configured a reloadable policy file. */
    readonly reloadable: boolean;
}
export declare function createDirectOpsRuntime(rowConfig: DirectOpsConfigInput): DirectOpsRuntime;
export declare function describePolicy(policy: DirectOpsPolicy, runtime: DirectOpsRuntime): DirectOpsPolicyView;
/**
 * Register the direct surface on an MCP server.
 *
 * Separate from the agent-control tools so the surface is visible and auditable
 * as one unit, and so a host can mount it on its own listener when a deployment
 * wants the direct surface reachable only on loopback.
 */
export declare function registerDirectOpsTools(server: McpServer, runtime: DirectOpsRuntime): void;

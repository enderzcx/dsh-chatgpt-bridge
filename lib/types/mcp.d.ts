/**
 * MCP server surface.
 *
 * Two families share this endpoint so ChatGPT needs one connection:
 *
 *   1. Agent-control tools (dsh_*) — these drive real DSH sessions, agents,
 *      goals and approvals. They consume model reasoning and are the only way
 *      to reach DSH internals.
 *   2. Direct-operation tools (dsh_read_text_file, dsh_write_text_file,
 *      dsh_edit_text_file, dsh_run_command, dsh_operator_*) — these run
 *      locally in this process against the trusted direct-ops policy. They
 *      create no session, invoke no agent and consume no model turn.
 *
 * Outputs are JSON text blocks; failures are reported as isError results with
 * { error: { code, message } }.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Bridge } from './bridge.js';
import type { ResolvedBridgeConfig } from './config.js';
import type { BridgeLogger } from './log.js';
import { type DirectOpsRuntime } from './direct/tools.js';
export declare function createMcpServer(bridge: Bridge, cfg: ResolvedBridgeConfig, log: BridgeLogger, directOps?: DirectOpsRuntime): McpServer;

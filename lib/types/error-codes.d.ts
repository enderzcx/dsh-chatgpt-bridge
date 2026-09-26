/**
 * Runtime allowlists for the two error vocabularies this program owns.
 *
 * These exist so the diagnostics layer can accept an error code ONLY when it is
 * one of this program's own codes. Checking an arbitrary string for an
 * uppercase shape would let a caller-supplied string (a tool name, a method, a
 * crafted `error.code`) be stored as if it were a code, which is exactly how a
 * "secret-free" receipt could end up carrying a secret. An unknown value is
 * recorded as `UNKNOWN` instead.
 *
 * Keep these in sync with the throwing sites; `test/unit/diagnostics.test.mjs`
 * asserts that every code literal in `src/` appears here.
 */
/** Codes raised as BridgeError in this program. */
export declare const BRIDGE_ERROR_CODES: readonly string[];
/** Codes raised as DirectOpsError in this program. */
export declare const DIRECT_OPS_ERROR_CODES: readonly string[];
/** Codes raised by the codex app-server adapter in this program. */
export declare const CODEX_CLIENT_ERROR_CODES: readonly string[];
/** Codes the MCP layer itself produces for a call it refused to dispatch. */
export declare const MCP_SURFACE_ERROR_CODES: readonly string[];
/** Everything the diagnostics layer will accept as an error code. */
export declare function isKnownErrorCode(value: unknown): value is string;
export declare const UNKNOWN_ERROR_CODE = "UNKNOWN";

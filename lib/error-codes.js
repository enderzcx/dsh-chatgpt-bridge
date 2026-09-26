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
export const BRIDGE_ERROR_CODES = [
    'APPROVAL_NOT_FOUND',
    'APPROVAL_SESSION_MISMATCH',
    'APPROVAL_UNREACHABLE',
    'DELIVERY_NOT_ACCEPTED',
    'DELIVERY_UNSUPPORTED',
    'EMPTY_GOAL',
    'EMPTY_MESSAGE',
    'GOAL_INVALID',
    'GOAL_MESSAGE_PROTECTED',
    'GOAL_MESSAGE_STALE',
    'GOAL_NOT_FOUND',
    'INBOX_UNAVAILABLE',
    'INVALID_ANSWER',
    'MESSAGE_ALREADY_ADMITTED',
    'MESSAGE_EDIT_NON_TEXT',
    'MESSAGE_ID_REQUIRED',
    'MESSAGE_ID_UNKNOWN',
    'MESSAGE_NOT_PENDING',
    'MESSAGE_NOT_PROMOTABLE',
    'MESSAGE_VERSION_CONFLICT',
    'NO_RESULT_YET',
    'QUESTION_NOT_FOUND',
    'REQUEST_ID_CONFLICT',
    'REVISION_CONFLICT',
    'SESSION_CREATE_FAILED',
    'SESSION_NOT_FOUND',
    'SESSION_NOT_LIVE',
    'SESSION_REQUIRED',
    'STEER_RECOVERY_REQUIRED',
    'STEER_REDELIVERY_FAILED',
    'STEER_UNAVAILABLE',
    'WORKSPACE_LOCKED',
    'WORKSPACE_NOT_FOUND',
    'WORKSPACE_REGISTRY_UNAVAILABLE',
];
/** Codes raised as DirectOpsError in this program. */
export const DIRECT_OPS_ERROR_CODES = [
    'ASYNC_UNSUPPORTED_BACKEND',
    'CODEX_ALREADY_STARTED',
    'CODEX_BAD_RESULT',
    'CODEX_BIN_UNCONFIGURED',
    'CODEX_CLOSED',
    'CODEX_EMPTY_COMMAND',
    'CODEX_EXEC_FAILED',
    'CODEX_EXITED',
    'CODEX_METHOD_NOT_ALLOWED',
    'CODEX_NOT_RUNNING',
    'CODEX_POLICY_UNSUPPORTED',
    'CODEX_REQUEST_TIMEOUT',
    'CODEX_RPC_ERROR',
    'CODEX_SPAWN_FAILED',
    'CODEX_WRITE_FAILED',
    'COMMAND_NOT_ALLOWED',
    'DIRECT_OPS_DISABLED',
    'EDIT_AMBIGUOUS',
    'EDIT_NOT_FOUND',
    'EXEC_DISABLED',
    'FILE_TOO_LARGE',
    'INTERNAL',
    'INVALID_ARGUMENT',
    'INVALID_PATH',
    'IS_BINARY',
    'LOCK_BUSY',
    'NOT_A_FILE',
    'NOT_FOUND',
    'NOT_READABLE',
    'PATH_DENIED',
    'PATH_OUTSIDE_ROOTS',
    'PATH_REDIRECTED',
    'POST_COMMIT_CONFLICT',
    'READ_REQUIRED',
    'RUN_LIMIT_REACHED',
    'RUN_NOT_FOUND',
    'RUN_TERMINATE_FAILED',
    'SANDBOX_UNAVAILABLE',
    'SPAWN_FAILED',
    'TOO_MANY_EDITS',
    'VERSION_CONFLICT',
    'WRITE_CONFLICT',
    'WRITE_DISABLED',
];
/** Codes raised by the codex app-server adapter in this program. */
export const CODEX_CLIENT_ERROR_CODES = [
    'CODEX_INIT_FAILED',
];
/** Codes the MCP layer itself produces for a call it refused to dispatch. */
export const MCP_SURFACE_ERROR_CODES = [
    'INVALID_ARGUMENTS',
    'UNKNOWN',
    'INTERNAL',
];
/** Everything the diagnostics layer will accept as an error code. */
export function isKnownErrorCode(value) {
    if (typeof value !== 'string')
        return false;
    return KNOWN_ERROR_CODES.has(value);
}
const KNOWN_ERROR_CODES = new Set([
    ...BRIDGE_ERROR_CODES,
    ...DIRECT_OPS_ERROR_CODES,
    ...CODEX_CLIENT_ERROR_CODES,
    ...MCP_SURFACE_ERROR_CODES,
]);
export const UNKNOWN_ERROR_CODE = 'UNKNOWN';

/**
 * Direct-operation surface: types.
 *
 * "Direct" means ChatGPT calls these MCP tools straight into local file and
 * process operations on the DSH host. No agent session is created, no model
 * turn is consumed, no DSH tool is invoked. Authorization comes from the
 * server-side trusted policy (config resolved at plugin load / policy reload),
 * never from arguments the caller supplies.
 */
export class DirectOpsError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.name = 'DirectOpsError';
        this.code = code;
        if (details !== undefined)
            this.details = details;
    }
}

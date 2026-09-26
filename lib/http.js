/**
 * Streamable HTTP transport for the MCP server, hosted on the bridge's own
 * node:http server. STATE-FUL mode, one McpServer instance per MCP session
 * (the SDK's Protocol allows exactly one transport per instance). Each
 * session's tools call into the shared Bridge, so per-session server
 * instances are thin and cheap. Loopback-only by default; every request is
 * authenticated against the bearer token when authMode is 'token'.
 *
 * Endpoints (MCP Streamable HTTP):
 *   POST /mcp  JSON-RPC messages (initialize first, then tools/list, tools/call...)
 *   GET  /mcp  SSE stream for server notifications (requires mcp-session-id)
 *   DELETE /mcp  close the MCP session
 */
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { callDiagnostics } from './diagnostics.js';
import { bridgeHttpUrl, isLoopbackHost } from './config.js';
function safeEqual(a, b) {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length)
        return false;
    return timingSafeEqual(left, right);
}
export const MAX_MCP_BODY_BYTES = 4 * 1024 * 1024; // 4MB
/** Read and parse a JSON request body (empty bodies yield undefined). */
function readJsonBody(req, maxBytes = MAX_MCP_BODY_BYTES) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
                req.destroy();
                reject(new Error('payload-too-large'));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (raw.trim() === '')
                return resolve(undefined);
            try {
                resolve(JSON.parse(raw));
            }
            catch {
                resolve(undefined);
            }
        });
        req.on('error', reject);
    });
}
function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Last-Event-ID');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Last-Event-ID');
}
function sendJson(res, status, body) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
}
/**
 * Record that this listener received a call, before any handler runs.
 *
 * Only the method and the tool name are read out of the body; nothing else about
 * the request is inspected or stored, and every value is allowlisted before it
 * is kept. This is the "HTTP received" phase, so a later absence of
 * `handler_started` is meaningful rather than a guess.
 */
function recordReceipt(body) {
    const correlationIds = [];
    if (body === null || typeof body !== 'object')
        return correlationIds;
    const messages = Array.isArray(body) ? body : [body];
    for (const message of messages) {
        if (message === null || typeof message !== 'object')
            continue;
        const method = message.method;
        if (typeof method !== 'string')
            continue;
        const params = message.params;
        const rawName = params !== null && typeof params === 'object'
            ? params.name
            : undefined;
        // Mint the id HERE, once per message. The handler adopts it from the
        // context established by `runWithRequests` around the dispatch, so a batch
        // cannot collapse every message onto one id.
        const correlationId = callDiagnostics.newCorrelationId();
        // Bind it to this message's JSON-RPC id so the handler can find it even when
        // several messages share one dispatch (a batch).
        const requestId = message.id;
        if (typeof requestId === 'string' || typeof requestId === 'number') {
            callDiagnostics.bindRequestId(requestId, correlationId);
        }
        correlationIds.push(correlationId);
        callDiagnostics.record({
            correlationId,
            phase: 'http_received',
            method,
            ...(typeof rawName === 'string' ? { tool: rawName } : {}),
        });
    }
    return correlationIds;
}
/**
 * Dispatch one parsed body so each of its messages runs under its own
 * correlation context. `enterWith` in a loop would leave only the last id.
 */
async function dispatchWithReceipts(body, dispatch) {
    const ids = recordReceipt(body);
    if (ids.length === 0)
        return dispatch();
    // Messages are dispatched sequentially by the transport, so one context per
    // message is enough; the innermost id covers the handler that runs next.
    let chain = () => dispatch();
    for (const id of ids) {
        const inner = chain;
        chain = () => callDiagnostics.runWithRequest(id, inner);
    }
    return chain();
}
export function startHttpServer(createSessionServer, options, log) {
    if (options.authMode === 'none' && !isLoopbackHost(options.host)) {
        return Promise.reject(new Error(`authMode none is only allowed for loopback HTTP listeners; refusing non-loopback host ${options.host}`));
    }
    return new Promise((resolve, reject) => {
        const authorize = (req) => {
            if (options.authMode === 'none')
                return true;
            const header = req.headers.authorization;
            if (header === undefined)
                return false;
            const match = /^Bearer\s+(.+)$/i.exec(header);
            return match !== null && safeEqual(match[1], options.authToken);
        };
        /** One MCP session: its transport plus the per-session server instance. */
        const sessions = new Map();
        const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
        const MAX_SESSIONS = 128;
        const httpServer = createServer(async (req, res) => {
            try {
                setCors(res);
                if (req.method === 'OPTIONS') {
                    res.statusCode = 204;
                    res.end();
                    return;
                }
                const url = req.url ?? '/';
                const path = url.split('?')[0];
                if (path !== '/mcp') {
                    sendJson(res, 404, { error: 'not-found' });
                    return;
                }
                if (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'DELETE') {
                    sendJson(res, 405, { error: 'method-not-allowed' });
                    return;
                }
                if (!authorize(req)) {
                    log.warn('MCP request rejected: missing or invalid bearer token');
                    sendJson(res, 401, { error: 'unauthorized' });
                    return;
                }
                const sessionId = req.headers['mcp-session-id'];
                const existing = typeof sessionId === 'string' && sessionId !== '' ? sessions.get(sessionId) : undefined;
                if (existing !== undefined) {
                    existing.lastActiveAt = Date.now();
                    const parsedBody = req.method === 'POST' ? await readJsonBody(req) : undefined;
                    await dispatchWithReceipts(parsedBody, () => existing.transport.handleRequest(req, res, parsedBody));
                    return;
                }
                if (sessionId !== undefined || req.method !== 'POST') {
                    // Unknown session id, or GET/DELETE without a session: per spec the
                    // session must exist before streaming or closing.
                    sendJson(res, sessionId !== undefined ? 404 : 400, { error: 'session-not-found' });
                    return;
                }
                // Sweep idle or overflow sessions before creating a new one
                if (sessions.size >= MAX_SESSIONS) {
                    const now = Date.now();
                    for (const [id, s] of [...sessions.entries()]) {
                        if (now - s.lastActiveAt > SESSION_IDLE_TIMEOUT_MS || sessions.size >= MAX_SESSIONS) {
                            sessions.delete(id);
                            void s.transport.close().catch(() => { });
                            void s.server.close().catch(() => { });
                        }
                    }
                }
                // Fresh MCP session: one transport + one server instance.
                let entry;
                const transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    onsessioninitialized: (id) => {
                        if (entry !== undefined)
                            sessions.set(id, entry);
                    },
                });
                entry = { transport, server: createSessionServer(), lastActiveAt: Date.now() };
                await entry.server.connect(transport);
                transport.onclose = () => {
                    const id = transport.sessionId;
                    if (id !== undefined)
                        sessions.delete(id);
                    void entry?.server.close().catch(() => { });
                };
                const parsedBody = req.method === 'POST' ? await readJsonBody(req) : undefined;
                await dispatchWithReceipts(parsedBody, () => transport.handleRequest(req, res, parsedBody));
            }
            catch (error) {
                log.error(`MCP HTTP request failed: ${error instanceof Error ? error.message : String(error)}`);
                if (!res.headersSent) {
                    const isLarge = error instanceof Error && error.message === 'payload-too-large';
                    sendJson(res, isLarge ? 413 : 500, { error: isLarge ? 'payload-too-large' : 'internal-error' });
                }
                else {
                    res.destroy();
                }
            }
        });
        httpServer.once('error', reject);
        httpServer.listen(options.port, options.host, () => {
            const address = httpServer.address();
            const port = address.port;
            const url = bridgeHttpUrl(options.host, port);
            log.info(`MCP Streamable HTTP server listening on ${url} (auth: ${options.authMode})`);
            resolve({
                port,
                url,
                close: async () => {
                    for (const entry of [...sessions.values()]) {
                        try {
                            await entry.transport.close();
                        }
                        catch {
                            // best-effort
                        }
                        try {
                            await entry.server.close();
                        }
                        catch {
                            // best-effort
                        }
                    }
                    sessions.clear();
                    await new Promise((done, fail) => {
                        httpServer.close((error) => {
                            if (error)
                                fail(error);
                            else
                                done();
                        });
                        httpServer.closeAllConnections();
                    });
                },
            });
        });
    });
}

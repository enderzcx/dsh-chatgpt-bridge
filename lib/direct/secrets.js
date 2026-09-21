/**
 * Direct-surface secret hygiene.
 *
 * Two rules, both enforced here so every file/exec path shares one implementation:
 *   1. Credential-shaped paths are refused before any read/write happens.
 *   2. Error text and log payloads are scrubbed of token-shaped substrings, so a
 *      refusal never becomes an oracle for the secret it protected.
 */
import { DirectOpsError } from './types.js';
/**
 * Path segments that are credential stores on this platform. Matching is on the
 * lowercased segment, so `~/.ssh` and `~/.SSH` are both refused. This is a
 * defence-in-depth denylist for obvious credential stores; the primary boundary
 * is still the trusted root list.
 */
export const DEFAULT_DENIED_SEGMENTS = [
    '.ssh',
    '.aws',
    '.gnupg',
    '.gpg',
    '.kube',
    '.docker',
    '.netrc',
    '.npmrc',
    '.pypirc',
    '.git-credentials',
    '.password-store',
    '.dsh/chatgpt-bridge/secrets',
];
/** Basenames (or basename prefixes) that are credential files. */
export const DEFAULT_DENIED_BASENAMES = [
    /^\.env(\..+)?$/i,
    /^\.credentials.*$/i,
    /^credentials(\.|$)/i,
    /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
    /^.*\.(pem|key|p12|pfx|jks|keystore)$/i,
    /^.*-service-account.*\.json$/i,
    /^serviceaccount.*\.json$/i,
    /^known_hosts$/i,
    /^shadow$/i,
    /^master\.key$/i,
];
/** Secret-shaped substrings in error text; mirrors src/redact.ts intent. */
const SECRET_PATTERNS = [
    /(?:authorization|auth)\s*[:=]\s*bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    /(?:api[_-]?key|access[_-]?token|authorization|auth|secret|credential|cookie|session[_-]?token|password|passwd|token|otp|one[-_]?time[-_]?password|2fa[-_]?code)\s*[:=]\s*["']?[^"'\s,;)]{4,}/gi,
    /bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    /\bsk-[A-Za-z0-9_-]{8,}/g,
    /\b(?:ghp|gho|ghs|ghu|glpat|xox[baprs])-[A-Za-z0-9_-]{8,}/g,
    /\bAKIA[0-9A-Z]{12,}\b/g,
];
export function scrubSecrets(text) {
    let out = text;
    for (const pattern of SECRET_PATTERNS) {
        pattern.lastIndex = 0;
        out = out.replace(pattern, '[REDACTED]');
    }
    return out;
}
/** Redact any credential-looking path so it can never be used to probe values. */
export function scrubPathForDisplay(path) {
    return scrubSecrets(path);
}
function basenameOf(path) {
    const parts = path.split('/');
    return parts[parts.length - 1] ?? '';
}
/**
 * Refuse paths whose basename looks like a credential file. Applied to reads and
 * writes alike: ChatGPT must not be able to exfiltrate a key through this path.
 */
export function assertNotCredentialFile(canonicalPath, deniedBasenames) {
    const base = basenameOf(canonicalPath);
    for (const pattern of deniedBasenames) {
        pattern.lastIndex = 0;
        if (pattern.test(base)) {
            throw new DirectOpsError('PATH_DENIED', `refusing to touch a credential-shaped file name (matched ${String(pattern)})`, { path: scrubPathForDisplay(canonicalPath) });
        }
    }
}
export { basenameOf as directBasenameOf };

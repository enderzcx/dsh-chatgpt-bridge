/**
 * Direct-surface secret hygiene.
 *
 * Two rules, both enforced here so every file/exec path shares one implementation:
 *   1. Credential-shaped paths are refused before any read/write happens.
 *   2. Error text and log payloads are scrubbed of token-shaped substrings, so a
 *      refusal never becomes an oracle for the secret it protected.
 */
import { type DirectOpsPolicy } from './types.js';
/**
 * Path segments that are credential stores on this platform. Matching is on the
 * lowercased segment, so `~/.ssh` and `~/.SSH` are both refused. This is a
 * defence-in-depth denylist for obvious credential stores; the primary boundary
 * is still the trusted root list.
 */
export declare const DEFAULT_DENIED_SEGMENTS: string[];
/** Basenames (or basename prefixes) that are credential files. */
export declare const DEFAULT_DENIED_BASENAMES: RegExp[];
export declare function scrubSecrets(text: string): string;
/** Redact any credential-looking path so it can never be used to probe values. */
export declare function scrubPathForDisplay(path: string): string;
declare function basenameOf(path: string): string;
/**
 * Refuse paths whose basename looks like a credential file. Applied to reads and
 * writes alike: ChatGPT must not be able to exfiltrate a key through this path.
 */
export declare function assertNotCredentialFile(canonicalPath: string, deniedBasenames: RegExp[]): void;
export { basenameOf as directBasenameOf };
/**
 * Environment for a codex app-server child.
 *
 * Rebuilt from the policy's explicit passthrough list, never inherited: a
 * provider key, bridge token, or unrelated export in the bridge's own
 * environment must not reach a child that the cloud client can drive. `PATH` is
 * present because the server needs it to resolve the executable and to run its
 * own helpers.
 */
export declare function buildCodexEnv(policy: DirectOpsPolicy): Record<string, string>;

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

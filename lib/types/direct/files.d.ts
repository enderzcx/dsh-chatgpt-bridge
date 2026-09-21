import { type DirectOpsPolicy } from './types.js';
export interface FileVersionInfo {
    /** sha256 of the bytes this read reached (the whole file when complete). */
    sha256: string;
    /** Bytes hashed. Equals `size` when the read was complete. */
    bytes_hashed: number;
    /** Total file size on disk at read time. */
    size: number;
    mtime_ms: number;
    /** False when `bytes_hashed < size`, i.e. the hash covers only a prefix. */
    complete: boolean;
}
export interface ReadResult {
    path: string;
    root: string;
    file_version: FileVersionInfo;
    encoding: string;
    line_count: number;
    /** True when line_count covers the whole file rather than only the read window. */
    line_count_complete: boolean;
    line_start: number;
    line_end: number;
    lines_returned: number;
    truncated: boolean;
    /**
     * `none` — the caller got the requested lines and the whole file was read;
     * `line_range` — the server page size capped the window;
     * `byte_budget` — the read byte budget was reached before the requested lines,
     *   so later lines are reachable only by paging with a larger window;
     * `empty` — the file has no content.
     */
    truncation: 'none' | 'line_range' | 'byte_budget' | 'line_too_long' | 'empty';
    /** True when the server page size (not the byte budget) capped the window. */
    line_window_capped: boolean;
    next_line?: number;
    binary: false;
    content: string;
    duration_ms: number;
}
export interface WriteResult {
    path: string;
    root: string;
    created: boolean;
    bytes_written: number;
    file_version: FileVersionInfo;
    previous_version?: FileVersionInfo;
    /** Permission bits of the file after the write, as octal. */
    mode: string;
    duration_ms: number;
}
export interface EditResult extends WriteResult {
    replacements: number;
    first_replacement_line?: number;
}
/**
 * FIFO mutex.
 *
 * The earlier tail-promise design leaked the lock to a *later* waiter when the
 * middle waiter timed out: the timed-out waiter released a gate that the next
 * waiter was chained to, so two writers could run at once. This queue version
 * removes a timed-out waiter from the queue and hands the lock directly to the
 * next real waiter.
 */
declare class PathLocks {
    private readonly held;
    private readonly queue;
    withLock<T>(key: string, fn: () => Promise<T>, waitMs?: number): Promise<T>;
    private acquire;
    private release;
    /** Test seam: how many waiters are queued for a path right now. */
    queuedFor(key: string): number;
}
export declare const pathLocks: PathLocks;
export interface ReadInput {
    path: string;
    start_line?: number;
    end_line?: number;
    max_bytes?: number;
}
export declare function readTextFile(input: ReadInput, policy: DirectOpsPolicy): Promise<ReadResult>;
export interface WriteInput {
    path: string;
    content: string;
    mode?: 'create' | 'overwrite';
    expected_sha256?: string;
    create_dirs?: boolean;
}
export declare function writeTextFile(input: WriteInput, policy: DirectOpsPolicy): Promise<WriteResult>;
export interface EditInput {
    path: string;
    old_text: string;
    new_text: string;
    replace_all?: boolean;
    expected_sha256?: string;
    max_replacements?: number;
}
export declare function editTextFile(input: EditInput, policy: DirectOpsPolicy): Promise<EditResult>;
/** Version of a file without returning its content. */
export declare function versionOfFile(path: string, policy: DirectOpsPolicy): Promise<FileVersionInfo>;
export {};

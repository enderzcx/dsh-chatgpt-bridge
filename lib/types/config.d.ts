import z from '@deepseek-ai/schemastery';
import type { LogLevel } from './log.js';
/**
 * Plugin configuration (schemastery schema, DSH convention). All defaults are
 * security-first: loopback-only host, bearer-token auth, bounded result sizes.
 */
export declare const ConfigSchema: z<Schemastery.ObjectS<{
    /** MCP transport: 'http' (Streamable HTTP) or 'stdio' (local MCP clients). */
    transport: z<"http" | "stdio", "http" | "stdio">;
    /** Bind host for the Streamable HTTP server. Loopback only by default. */
    host: z<string, string>;
    /** Bind port for the Streamable HTTP server. */
    port: z<number, number>;
    /** 'token' requires Authorization: Bearer <token>; 'none' disables auth (loopback only, not recommended). */
    authMode: z<"none" | "token", "none" | "token">;
    /** Static token; empty falls back to authTokenEnv, then a generated token persisted to tokenFile. */
    authToken: z<string, string>;
    /** Environment variable read when authToken is empty. */
    authTokenEnv: z<string, string>;
    /** Where a generated token is persisted; empty means $DSH_HOME/chatgpt-bridge.token. */
    tokenFile: z<string, string>;
    /** Max characters of assistant text returned by dsh_get_result. */
    resultMaxChars: z<number, number>;
    /** Max tool calls returned by dsh_get_result. */
    resultMaxItems: z<number, number>;
    /** Max message rows returned by dsh_get_session. */
    sessionMaxItems: z<number, number>;
    /** Max characters per message text returned by dsh_get_session. */
    sessionMaxChars: z<number, number>;
    /** Log verbosity: debug | info | warn | error. */
    logLevel: z<"error" | "debug" | "info" | "warn", "error" | "debug" | "info" | "warn">;
    /** Risk-tiered auto-approval policy. Omitted fields keep the safe defaults. */
    approvalPolicy: z<Schemastery.ObjectS<{
        read: z<"auto" | "ask", "auto" | "ask">;
        test: z<"auto" | "ask", "auto" | "ask">;
        build: z<"auto" | "ask", "auto" | "ask">;
        workspaceWrite: z<"auto" | "ask", "auto" | "ask">;
        localCommit: z<"auto" | "ask", "auto" | "ask">;
        externalWrite: z<"auto" | "ask", "auto" | "ask">;
        gitPush: z<"auto" | "ask", "auto" | "ask">;
        npmPublish: z<"auto" | "ask", "auto" | "ask">;
        githubRelease: z<"auto" | "ask", "auto" | "ask">;
        secrets: z<"deny" | "ask", "deny" | "ask">;
        dangerFullAccess: z<"deny" | "ask", "deny" | "ask">;
    }>, Schemastery.ObjectT<{
        read: z<"auto" | "ask", "auto" | "ask">;
        test: z<"auto" | "ask", "auto" | "ask">;
        build: z<"auto" | "ask", "auto" | "ask">;
        workspaceWrite: z<"auto" | "ask", "auto" | "ask">;
        localCommit: z<"auto" | "ask", "auto" | "ask">;
        externalWrite: z<"auto" | "ask", "auto" | "ask">;
        gitPush: z<"auto" | "ask", "auto" | "ask">;
        npmPublish: z<"auto" | "ask", "auto" | "ask">;
        githubRelease: z<"auto" | "ask", "auto" | "ask">;
        secrets: z<"deny" | "ask", "deny" | "ask">;
        dangerFullAccess: z<"deny" | "ask", "deny" | "ask">;
    }>>;
    /**
     * Direct local operations (no agent / no model). Off unless roots are named.
     * These values are the ONLY authorization for the direct surface: no MCP tool
     * argument can add a root, enable writes, or enable command execution.
     */
    directOps: z<Schemastery.ObjectS<{
        /** Master switch. Closed unless true AND explicit roots are named. */
        enabled: z<boolean, boolean>;
        /** Allow create/overwrite/edit inside roots listed in writableRoots. */
        allowWrites: z<boolean, boolean>;
        /** Trusted read roots. Absolute paths; realpath is enforced. */
        roots: z<string[], string[]>;
        /** Subset of roots that accept writes. Absolute paths. */
        writableRoots: z<string[], string[]>;
        /** Trusted JSON policy file, re-readable at runtime by dsh_operator_reload_policy. */
        policyFile: z<string, string>;
        /** Extra denied path segments on top of the built-in credential denylist. */
        deniedNames: z<string[], string[]>;
        limits: z<Schemastery.ObjectS<{
            readMaxBytes: z<number, number>;
            readMaxLines: z<number, number>;
            readMaxWindowBytes: z<number, number>;
            writeMaxBytes: z<number, number>;
            execMaxOutputBytes: z<number, number>;
            execTimeoutMs: z<number, number>;
            execMaxTimeoutMs: z<number, number>;
        }>, Schemastery.ObjectT<{
            readMaxBytes: z<number, number>;
            readMaxLines: z<number, number>;
            readMaxWindowBytes: z<number, number>;
            writeMaxBytes: z<number, number>;
            execMaxOutputBytes: z<number, number>;
            execTimeoutMs: z<number, number>;
            execMaxTimeoutMs: z<number, number>;
        }>>;
        exec: z<Schemastery.ObjectS<{
            /** High-privilege; a local administrator must turn this on deliberately. */
            enabled: z<boolean, boolean>;
            /**
             * Required when enabled UNLESS `fullAccess` is true. There is no implicit
             * "any command" mode: a restricted policy always needs a name allowlist.
             */
            allowedCommands: z<string[], string[]>;
            /** Trusted roots a command cwd may use; defaults to the read roots. */
            cwdRoots: z<string[], string[]>;
            /** Roots the child may write. Empty means the sandbox grants no writes. */
            writableRoots: z<string[], string[]>;
            network: z<"deny" | "allow", "deny" | "allow">;
            filesystem: z<"roots" | "inherit", "roots" | "inherit">;
            /** "required": refuse to run when no OS sandbox can enforce the boundary. */
            sandbox: z<"required" | "preferred", "required" | "preferred">;
            envPassthrough: z<string[], string[]>;
            /**
             * Extra PATH entries used to RESOLVE an allowlisted name. Needed on hosts
             * whose service PATH lacks the install prefix (for example
             * `/opt/homebrew/bin` for a Homebrew `node`).
             */
            pathEntries: z<string[], string[]>;
            /**
             * Administrator-only full access. When true the child runs with NO OS
             * sandbox: any bare executable name resolves, any existing directory may be
             * the cwd, and reads, writes, temp directories and the network are
             * unconfined (codex `dangerFullAccess`). Default false, requires the
             * `codex-app-server` backend, and can ONLY be set by this trusted
             * configuration — no tool argument can reach it.
             */
            fullAccess: z<boolean, boolean>;
            /**
             * Absolute path to the codex executable for the app-server backend. Empty
             * means unset; the bridge never guesses it from PATH.
             */
            codexBin: z<string, string>;
            /** Extra argv for the app-server child, e.g. `-c key=value`. */
            codexArgs: z<string[], string[]>;
            /**
             * Isolated CODEX_HOME for the app-server child, so it does not read the
             * user's global ~/.codex configuration.
             */
            codexHome: z<string, string>;
            backend: z<"sandbox-exec" | "codex-app-server", "sandbox-exec" | "codex-app-server">;
            asyncMaxRuns: z<number, number>;
            asyncMaxOutputBytes: z<number, number>;
        }>, Schemastery.ObjectT<{
            /** High-privilege; a local administrator must turn this on deliberately. */
            enabled: z<boolean, boolean>;
            /**
             * Required when enabled UNLESS `fullAccess` is true. There is no implicit
             * "any command" mode: a restricted policy always needs a name allowlist.
             */
            allowedCommands: z<string[], string[]>;
            /** Trusted roots a command cwd may use; defaults to the read roots. */
            cwdRoots: z<string[], string[]>;
            /** Roots the child may write. Empty means the sandbox grants no writes. */
            writableRoots: z<string[], string[]>;
            network: z<"deny" | "allow", "deny" | "allow">;
            filesystem: z<"roots" | "inherit", "roots" | "inherit">;
            /** "required": refuse to run when no OS sandbox can enforce the boundary. */
            sandbox: z<"required" | "preferred", "required" | "preferred">;
            envPassthrough: z<string[], string[]>;
            /**
             * Extra PATH entries used to RESOLVE an allowlisted name. Needed on hosts
             * whose service PATH lacks the install prefix (for example
             * `/opt/homebrew/bin` for a Homebrew `node`).
             */
            pathEntries: z<string[], string[]>;
            /**
             * Administrator-only full access. When true the child runs with NO OS
             * sandbox: any bare executable name resolves, any existing directory may be
             * the cwd, and reads, writes, temp directories and the network are
             * unconfined (codex `dangerFullAccess`). Default false, requires the
             * `codex-app-server` backend, and can ONLY be set by this trusted
             * configuration — no tool argument can reach it.
             */
            fullAccess: z<boolean, boolean>;
            /**
             * Absolute path to the codex executable for the app-server backend. Empty
             * means unset; the bridge never guesses it from PATH.
             */
            codexBin: z<string, string>;
            /** Extra argv for the app-server child, e.g. `-c key=value`. */
            codexArgs: z<string[], string[]>;
            /**
             * Isolated CODEX_HOME for the app-server child, so it does not read the
             * user's global ~/.codex configuration.
             */
            codexHome: z<string, string>;
            backend: z<"sandbox-exec" | "codex-app-server", "sandbox-exec" | "codex-app-server">;
            asyncMaxRuns: z<number, number>;
            asyncMaxOutputBytes: z<number, number>;
        }>>;
    }>, Schemastery.ObjectT<{
        /** Master switch. Closed unless true AND explicit roots are named. */
        enabled: z<boolean, boolean>;
        /** Allow create/overwrite/edit inside roots listed in writableRoots. */
        allowWrites: z<boolean, boolean>;
        /** Trusted read roots. Absolute paths; realpath is enforced. */
        roots: z<string[], string[]>;
        /** Subset of roots that accept writes. Absolute paths. */
        writableRoots: z<string[], string[]>;
        /** Trusted JSON policy file, re-readable at runtime by dsh_operator_reload_policy. */
        policyFile: z<string, string>;
        /** Extra denied path segments on top of the built-in credential denylist. */
        deniedNames: z<string[], string[]>;
        limits: z<Schemastery.ObjectS<{
            readMaxBytes: z<number, number>;
            readMaxLines: z<number, number>;
            readMaxWindowBytes: z<number, number>;
            writeMaxBytes: z<number, number>;
            execMaxOutputBytes: z<number, number>;
            execTimeoutMs: z<number, number>;
            execMaxTimeoutMs: z<number, number>;
        }>, Schemastery.ObjectT<{
            readMaxBytes: z<number, number>;
            readMaxLines: z<number, number>;
            readMaxWindowBytes: z<number, number>;
            writeMaxBytes: z<number, number>;
            execMaxOutputBytes: z<number, number>;
            execTimeoutMs: z<number, number>;
            execMaxTimeoutMs: z<number, number>;
        }>>;
        exec: z<Schemastery.ObjectS<{
            /** High-privilege; a local administrator must turn this on deliberately. */
            enabled: z<boolean, boolean>;
            /**
             * Required when enabled UNLESS `fullAccess` is true. There is no implicit
             * "any command" mode: a restricted policy always needs a name allowlist.
             */
            allowedCommands: z<string[], string[]>;
            /** Trusted roots a command cwd may use; defaults to the read roots. */
            cwdRoots: z<string[], string[]>;
            /** Roots the child may write. Empty means the sandbox grants no writes. */
            writableRoots: z<string[], string[]>;
            network: z<"deny" | "allow", "deny" | "allow">;
            filesystem: z<"roots" | "inherit", "roots" | "inherit">;
            /** "required": refuse to run when no OS sandbox can enforce the boundary. */
            sandbox: z<"required" | "preferred", "required" | "preferred">;
            envPassthrough: z<string[], string[]>;
            /**
             * Extra PATH entries used to RESOLVE an allowlisted name. Needed on hosts
             * whose service PATH lacks the install prefix (for example
             * `/opt/homebrew/bin` for a Homebrew `node`).
             */
            pathEntries: z<string[], string[]>;
            /**
             * Administrator-only full access. When true the child runs with NO OS
             * sandbox: any bare executable name resolves, any existing directory may be
             * the cwd, and reads, writes, temp directories and the network are
             * unconfined (codex `dangerFullAccess`). Default false, requires the
             * `codex-app-server` backend, and can ONLY be set by this trusted
             * configuration — no tool argument can reach it.
             */
            fullAccess: z<boolean, boolean>;
            /**
             * Absolute path to the codex executable for the app-server backend. Empty
             * means unset; the bridge never guesses it from PATH.
             */
            codexBin: z<string, string>;
            /** Extra argv for the app-server child, e.g. `-c key=value`. */
            codexArgs: z<string[], string[]>;
            /**
             * Isolated CODEX_HOME for the app-server child, so it does not read the
             * user's global ~/.codex configuration.
             */
            codexHome: z<string, string>;
            backend: z<"sandbox-exec" | "codex-app-server", "sandbox-exec" | "codex-app-server">;
            asyncMaxRuns: z<number, number>;
            asyncMaxOutputBytes: z<number, number>;
        }>, Schemastery.ObjectT<{
            /** High-privilege; a local administrator must turn this on deliberately. */
            enabled: z<boolean, boolean>;
            /**
             * Required when enabled UNLESS `fullAccess` is true. There is no implicit
             * "any command" mode: a restricted policy always needs a name allowlist.
             */
            allowedCommands: z<string[], string[]>;
            /** Trusted roots a command cwd may use; defaults to the read roots. */
            cwdRoots: z<string[], string[]>;
            /** Roots the child may write. Empty means the sandbox grants no writes. */
            writableRoots: z<string[], string[]>;
            network: z<"deny" | "allow", "deny" | "allow">;
            filesystem: z<"roots" | "inherit", "roots" | "inherit">;
            /** "required": refuse to run when no OS sandbox can enforce the boundary. */
            sandbox: z<"required" | "preferred", "required" | "preferred">;
            envPassthrough: z<string[], string[]>;
            /**
             * Extra PATH entries used to RESOLVE an allowlisted name. Needed on hosts
             * whose service PATH lacks the install prefix (for example
             * `/opt/homebrew/bin` for a Homebrew `node`).
             */
            pathEntries: z<string[], string[]>;
            /**
             * Administrator-only full access. When true the child runs with NO OS
             * sandbox: any bare executable name resolves, any existing directory may be
             * the cwd, and reads, writes, temp directories and the network are
             * unconfined (codex `dangerFullAccess`). Default false, requires the
             * `codex-app-server` backend, and can ONLY be set by this trusted
             * configuration — no tool argument can reach it.
             */
            fullAccess: z<boolean, boolean>;
            /**
             * Absolute path to the codex executable for the app-server backend. Empty
             * means unset; the bridge never guesses it from PATH.
             */
            codexBin: z<string, string>;
            /** Extra argv for the app-server child, e.g. `-c key=value`. */
            codexArgs: z<string[], string[]>;
            /**
             * Isolated CODEX_HOME for the app-server child, so it does not read the
             * user's global ~/.codex configuration.
             */
            codexHome: z<string, string>;
            backend: z<"sandbox-exec" | "codex-app-server", "sandbox-exec" | "codex-app-server">;
            asyncMaxRuns: z<number, number>;
            asyncMaxOutputBytes: z<number, number>;
        }>>;
    }>>;
}>, Schemastery.ObjectT<{
    /** MCP transport: 'http' (Streamable HTTP) or 'stdio' (local MCP clients). */
    transport: z<"http" | "stdio", "http" | "stdio">;
    /** Bind host for the Streamable HTTP server. Loopback only by default. */
    host: z<string, string>;
    /** Bind port for the Streamable HTTP server. */
    port: z<number, number>;
    /** 'token' requires Authorization: Bearer <token>; 'none' disables auth (loopback only, not recommended). */
    authMode: z<"none" | "token", "none" | "token">;
    /** Static token; empty falls back to authTokenEnv, then a generated token persisted to tokenFile. */
    authToken: z<string, string>;
    /** Environment variable read when authToken is empty. */
    authTokenEnv: z<string, string>;
    /** Where a generated token is persisted; empty means $DSH_HOME/chatgpt-bridge.token. */
    tokenFile: z<string, string>;
    /** Max characters of assistant text returned by dsh_get_result. */
    resultMaxChars: z<number, number>;
    /** Max tool calls returned by dsh_get_result. */
    resultMaxItems: z<number, number>;
    /** Max message rows returned by dsh_get_session. */
    sessionMaxItems: z<number, number>;
    /** Max characters per message text returned by dsh_get_session. */
    sessionMaxChars: z<number, number>;
    /** Log verbosity: debug | info | warn | error. */
    logLevel: z<"error" | "debug" | "info" | "warn", "error" | "debug" | "info" | "warn">;
    /** Risk-tiered auto-approval policy. Omitted fields keep the safe defaults. */
    approvalPolicy: z<Schemastery.ObjectS<{
        read: z<"auto" | "ask", "auto" | "ask">;
        test: z<"auto" | "ask", "auto" | "ask">;
        build: z<"auto" | "ask", "auto" | "ask">;
        workspaceWrite: z<"auto" | "ask", "auto" | "ask">;
        localCommit: z<"auto" | "ask", "auto" | "ask">;
        externalWrite: z<"auto" | "ask", "auto" | "ask">;
        gitPush: z<"auto" | "ask", "auto" | "ask">;
        npmPublish: z<"auto" | "ask", "auto" | "ask">;
        githubRelease: z<"auto" | "ask", "auto" | "ask">;
        secrets: z<"deny" | "ask", "deny" | "ask">;
        dangerFullAccess: z<"deny" | "ask", "deny" | "ask">;
    }>, Schemastery.ObjectT<{
        read: z<"auto" | "ask", "auto" | "ask">;
        test: z<"auto" | "ask", "auto" | "ask">;
        build: z<"auto" | "ask", "auto" | "ask">;
        workspaceWrite: z<"auto" | "ask", "auto" | "ask">;
        localCommit: z<"auto" | "ask", "auto" | "ask">;
        externalWrite: z<"auto" | "ask", "auto" | "ask">;
        gitPush: z<"auto" | "ask", "auto" | "ask">;
        npmPublish: z<"auto" | "ask", "auto" | "ask">;
        githubRelease: z<"auto" | "ask", "auto" | "ask">;
        secrets: z<"deny" | "ask", "deny" | "ask">;
        dangerFullAccess: z<"deny" | "ask", "deny" | "ask">;
    }>>;
    /**
     * Direct local operations (no agent / no model). Off unless roots are named.
     * These values are the ONLY authorization for the direct surface: no MCP tool
     * argument can add a root, enable writes, or enable command execution.
     */
    directOps: z<Schemastery.ObjectS<{
        /** Master switch. Closed unless true AND explicit roots are named. */
        enabled: z<boolean, boolean>;
        /** Allow create/overwrite/edit inside roots listed in writableRoots. */
        allowWrites: z<boolean, boolean>;
        /** Trusted read roots. Absolute paths; realpath is enforced. */
        roots: z<string[], string[]>;
        /** Subset of roots that accept writes. Absolute paths. */
        writableRoots: z<string[], string[]>;
        /** Trusted JSON policy file, re-readable at runtime by dsh_operator_reload_policy. */
        policyFile: z<string, string>;
        /** Extra denied path segments on top of the built-in credential denylist. */
        deniedNames: z<string[], string[]>;
        limits: z<Schemastery.ObjectS<{
            readMaxBytes: z<number, number>;
            readMaxLines: z<number, number>;
            readMaxWindowBytes: z<number, number>;
            writeMaxBytes: z<number, number>;
            execMaxOutputBytes: z<number, number>;
            execTimeoutMs: z<number, number>;
            execMaxTimeoutMs: z<number, number>;
        }>, Schemastery.ObjectT<{
            readMaxBytes: z<number, number>;
            readMaxLines: z<number, number>;
            readMaxWindowBytes: z<number, number>;
            writeMaxBytes: z<number, number>;
            execMaxOutputBytes: z<number, number>;
            execTimeoutMs: z<number, number>;
            execMaxTimeoutMs: z<number, number>;
        }>>;
        exec: z<Schemastery.ObjectS<{
            /** High-privilege; a local administrator must turn this on deliberately. */
            enabled: z<boolean, boolean>;
            /**
             * Required when enabled UNLESS `fullAccess` is true. There is no implicit
             * "any command" mode: a restricted policy always needs a name allowlist.
             */
            allowedCommands: z<string[], string[]>;
            /** Trusted roots a command cwd may use; defaults to the read roots. */
            cwdRoots: z<string[], string[]>;
            /** Roots the child may write. Empty means the sandbox grants no writes. */
            writableRoots: z<string[], string[]>;
            network: z<"deny" | "allow", "deny" | "allow">;
            filesystem: z<"roots" | "inherit", "roots" | "inherit">;
            /** "required": refuse to run when no OS sandbox can enforce the boundary. */
            sandbox: z<"required" | "preferred", "required" | "preferred">;
            envPassthrough: z<string[], string[]>;
            /**
             * Extra PATH entries used to RESOLVE an allowlisted name. Needed on hosts
             * whose service PATH lacks the install prefix (for example
             * `/opt/homebrew/bin` for a Homebrew `node`).
             */
            pathEntries: z<string[], string[]>;
            /**
             * Administrator-only full access. When true the child runs with NO OS
             * sandbox: any bare executable name resolves, any existing directory may be
             * the cwd, and reads, writes, temp directories and the network are
             * unconfined (codex `dangerFullAccess`). Default false, requires the
             * `codex-app-server` backend, and can ONLY be set by this trusted
             * configuration — no tool argument can reach it.
             */
            fullAccess: z<boolean, boolean>;
            /**
             * Absolute path to the codex executable for the app-server backend. Empty
             * means unset; the bridge never guesses it from PATH.
             */
            codexBin: z<string, string>;
            /** Extra argv for the app-server child, e.g. `-c key=value`. */
            codexArgs: z<string[], string[]>;
            /**
             * Isolated CODEX_HOME for the app-server child, so it does not read the
             * user's global ~/.codex configuration.
             */
            codexHome: z<string, string>;
            backend: z<"sandbox-exec" | "codex-app-server", "sandbox-exec" | "codex-app-server">;
            asyncMaxRuns: z<number, number>;
            asyncMaxOutputBytes: z<number, number>;
        }>, Schemastery.ObjectT<{
            /** High-privilege; a local administrator must turn this on deliberately. */
            enabled: z<boolean, boolean>;
            /**
             * Required when enabled UNLESS `fullAccess` is true. There is no implicit
             * "any command" mode: a restricted policy always needs a name allowlist.
             */
            allowedCommands: z<string[], string[]>;
            /** Trusted roots a command cwd may use; defaults to the read roots. */
            cwdRoots: z<string[], string[]>;
            /** Roots the child may write. Empty means the sandbox grants no writes. */
            writableRoots: z<string[], string[]>;
            network: z<"deny" | "allow", "deny" | "allow">;
            filesystem: z<"roots" | "inherit", "roots" | "inherit">;
            /** "required": refuse to run when no OS sandbox can enforce the boundary. */
            sandbox: z<"required" | "preferred", "required" | "preferred">;
            envPassthrough: z<string[], string[]>;
            /**
             * Extra PATH entries used to RESOLVE an allowlisted name. Needed on hosts
             * whose service PATH lacks the install prefix (for example
             * `/opt/homebrew/bin` for a Homebrew `node`).
             */
            pathEntries: z<string[], string[]>;
            /**
             * Administrator-only full access. When true the child runs with NO OS
             * sandbox: any bare executable name resolves, any existing directory may be
             * the cwd, and reads, writes, temp directories and the network are
             * unconfined (codex `dangerFullAccess`). Default false, requires the
             * `codex-app-server` backend, and can ONLY be set by this trusted
             * configuration — no tool argument can reach it.
             */
            fullAccess: z<boolean, boolean>;
            /**
             * Absolute path to the codex executable for the app-server backend. Empty
             * means unset; the bridge never guesses it from PATH.
             */
            codexBin: z<string, string>;
            /** Extra argv for the app-server child, e.g. `-c key=value`. */
            codexArgs: z<string[], string[]>;
            /**
             * Isolated CODEX_HOME for the app-server child, so it does not read the
             * user's global ~/.codex configuration.
             */
            codexHome: z<string, string>;
            backend: z<"sandbox-exec" | "codex-app-server", "sandbox-exec" | "codex-app-server">;
            asyncMaxRuns: z<number, number>;
            asyncMaxOutputBytes: z<number, number>;
        }>>;
    }>, Schemastery.ObjectT<{
        /** Master switch. Closed unless true AND explicit roots are named. */
        enabled: z<boolean, boolean>;
        /** Allow create/overwrite/edit inside roots listed in writableRoots. */
        allowWrites: z<boolean, boolean>;
        /** Trusted read roots. Absolute paths; realpath is enforced. */
        roots: z<string[], string[]>;
        /** Subset of roots that accept writes. Absolute paths. */
        writableRoots: z<string[], string[]>;
        /** Trusted JSON policy file, re-readable at runtime by dsh_operator_reload_policy. */
        policyFile: z<string, string>;
        /** Extra denied path segments on top of the built-in credential denylist. */
        deniedNames: z<string[], string[]>;
        limits: z<Schemastery.ObjectS<{
            readMaxBytes: z<number, number>;
            readMaxLines: z<number, number>;
            readMaxWindowBytes: z<number, number>;
            writeMaxBytes: z<number, number>;
            execMaxOutputBytes: z<number, number>;
            execTimeoutMs: z<number, number>;
            execMaxTimeoutMs: z<number, number>;
        }>, Schemastery.ObjectT<{
            readMaxBytes: z<number, number>;
            readMaxLines: z<number, number>;
            readMaxWindowBytes: z<number, number>;
            writeMaxBytes: z<number, number>;
            execMaxOutputBytes: z<number, number>;
            execTimeoutMs: z<number, number>;
            execMaxTimeoutMs: z<number, number>;
        }>>;
        exec: z<Schemastery.ObjectS<{
            /** High-privilege; a local administrator must turn this on deliberately. */
            enabled: z<boolean, boolean>;
            /**
             * Required when enabled UNLESS `fullAccess` is true. There is no implicit
             * "any command" mode: a restricted policy always needs a name allowlist.
             */
            allowedCommands: z<string[], string[]>;
            /** Trusted roots a command cwd may use; defaults to the read roots. */
            cwdRoots: z<string[], string[]>;
            /** Roots the child may write. Empty means the sandbox grants no writes. */
            writableRoots: z<string[], string[]>;
            network: z<"deny" | "allow", "deny" | "allow">;
            filesystem: z<"roots" | "inherit", "roots" | "inherit">;
            /** "required": refuse to run when no OS sandbox can enforce the boundary. */
            sandbox: z<"required" | "preferred", "required" | "preferred">;
            envPassthrough: z<string[], string[]>;
            /**
             * Extra PATH entries used to RESOLVE an allowlisted name. Needed on hosts
             * whose service PATH lacks the install prefix (for example
             * `/opt/homebrew/bin` for a Homebrew `node`).
             */
            pathEntries: z<string[], string[]>;
            /**
             * Administrator-only full access. When true the child runs with NO OS
             * sandbox: any bare executable name resolves, any existing directory may be
             * the cwd, and reads, writes, temp directories and the network are
             * unconfined (codex `dangerFullAccess`). Default false, requires the
             * `codex-app-server` backend, and can ONLY be set by this trusted
             * configuration — no tool argument can reach it.
             */
            fullAccess: z<boolean, boolean>;
            /**
             * Absolute path to the codex executable for the app-server backend. Empty
             * means unset; the bridge never guesses it from PATH.
             */
            codexBin: z<string, string>;
            /** Extra argv for the app-server child, e.g. `-c key=value`. */
            codexArgs: z<string[], string[]>;
            /**
             * Isolated CODEX_HOME for the app-server child, so it does not read the
             * user's global ~/.codex configuration.
             */
            codexHome: z<string, string>;
            backend: z<"sandbox-exec" | "codex-app-server", "sandbox-exec" | "codex-app-server">;
            asyncMaxRuns: z<number, number>;
            asyncMaxOutputBytes: z<number, number>;
        }>, Schemastery.ObjectT<{
            /** High-privilege; a local administrator must turn this on deliberately. */
            enabled: z<boolean, boolean>;
            /**
             * Required when enabled UNLESS `fullAccess` is true. There is no implicit
             * "any command" mode: a restricted policy always needs a name allowlist.
             */
            allowedCommands: z<string[], string[]>;
            /** Trusted roots a command cwd may use; defaults to the read roots. */
            cwdRoots: z<string[], string[]>;
            /** Roots the child may write. Empty means the sandbox grants no writes. */
            writableRoots: z<string[], string[]>;
            network: z<"deny" | "allow", "deny" | "allow">;
            filesystem: z<"roots" | "inherit", "roots" | "inherit">;
            /** "required": refuse to run when no OS sandbox can enforce the boundary. */
            sandbox: z<"required" | "preferred", "required" | "preferred">;
            envPassthrough: z<string[], string[]>;
            /**
             * Extra PATH entries used to RESOLVE an allowlisted name. Needed on hosts
             * whose service PATH lacks the install prefix (for example
             * `/opt/homebrew/bin` for a Homebrew `node`).
             */
            pathEntries: z<string[], string[]>;
            /**
             * Administrator-only full access. When true the child runs with NO OS
             * sandbox: any bare executable name resolves, any existing directory may be
             * the cwd, and reads, writes, temp directories and the network are
             * unconfined (codex `dangerFullAccess`). Default false, requires the
             * `codex-app-server` backend, and can ONLY be set by this trusted
             * configuration — no tool argument can reach it.
             */
            fullAccess: z<boolean, boolean>;
            /**
             * Absolute path to the codex executable for the app-server backend. Empty
             * means unset; the bridge never guesses it from PATH.
             */
            codexBin: z<string, string>;
            /** Extra argv for the app-server child, e.g. `-c key=value`. */
            codexArgs: z<string[], string[]>;
            /**
             * Isolated CODEX_HOME for the app-server child, so it does not read the
             * user's global ~/.codex configuration.
             */
            codexHome: z<string, string>;
            backend: z<"sandbox-exec" | "codex-app-server", "sandbox-exec" | "codex-app-server">;
            asyncMaxRuns: z<number, number>;
            asyncMaxOutputBytes: z<number, number>;
        }>>;
    }>>;
}>>;
import type { UserApprovalPolicy } from './approval-policy.js';
import { type DirectOpsConfigInput } from './direct/policy.js';
/** Input shape accepted from the cordis row config (schema input side). */
export interface BridgeConfigInput {
    transport?: 'http' | 'stdio';
    host?: string;
    port?: number;
    authMode?: 'token' | 'none';
    authToken?: string;
    authTokenEnv?: string;
    tokenFile?: string;
    resultMaxChars?: number;
    resultMaxItems?: number;
    sessionMaxItems?: number;
    sessionMaxChars?: number;
    logLevel?: LogLevel;
    approvalPolicy?: UserApprovalPolicy;
    directOps?: DirectOpsConfigInput;
}
/** Fully resolved configuration after token resolution. */
export interface ResolvedBridgeConfig {
    transport: 'http' | 'stdio';
    host: string;
    port: number;
    authMode: 'token' | 'none';
    authToken: string;
    tokenFile: string;
    resultMaxChars: number;
    resultMaxItems: number;
    sessionMaxItems: number;
    sessionMaxChars: number;
    logLevel: LogLevel;
    dshHome: string;
    approvalPolicy?: UserApprovalPolicy;
    directOps?: DirectOpsConfigInput;
}
/** Convert URL authority host syntax to the bare form required by sockets. */
export declare function normalizeSocketHostname(host: string): string;
/** True only for listener hosts whose bind scope is loopback-only. */
export declare function isLoopbackHost(host: string): boolean;
/** Select a concrete address that can reach a wildcard listener locally. */
export declare function bridgeConnectHost(listenerHost: string): string;
/** Build a syntactically valid local probe URL, including IPv6 brackets. */
export declare function bridgeHttpUrl(listenerHost: string, port: number): string;
export declare function defaultDshHome(env: Record<string, string | undefined>): string;
/** Resolve the effective configuration (defaults + token resolution). */
export declare function resolveConfig(input: BridgeConfigInput, env: Record<string, string | undefined>): ResolvedBridgeConfig;

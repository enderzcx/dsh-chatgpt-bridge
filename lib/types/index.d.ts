/**
 * dsh-chatgpt-bridge plugin entry: a DSH (Cordis) plugin row that mounts the
 * MCP bridge. Removing or disabling the row (or the bundle) makes the MCP
 * endpoint disappear while DSH keeps running untouched.
 */
import { Context } from '@deepseek-ai/cordis';
import { type BridgeConfigInput } from './config.js';
export declare const name = "chatgpt-bridge";
/** Core services the bridge needs before it can start. */
export declare const inject: string[];
/** Plugin configuration schema (schemastery, DSH convention). */
export declare const Config: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<{
    transport: import("@deepseek-ai/schemastery").default<"http" | "stdio", "http" | "stdio">;
    host: import("@deepseek-ai/schemastery").default<string, string>;
    port: import("@deepseek-ai/schemastery").default<number, number>;
    authMode: import("@deepseek-ai/schemastery").default<"none" | "token", "none" | "token">;
    authToken: import("@deepseek-ai/schemastery").default<string, string>;
    authTokenEnv: import("@deepseek-ai/schemastery").default<string, string>;
    tokenFile: import("@deepseek-ai/schemastery").default<string, string>;
    resultMaxChars: import("@deepseek-ai/schemastery").default<number, number>;
    resultMaxItems: import("@deepseek-ai/schemastery").default<number, number>;
    sessionMaxItems: import("@deepseek-ai/schemastery").default<number, number>;
    sessionMaxChars: import("@deepseek-ai/schemastery").default<number, number>;
    logLevel: import("@deepseek-ai/schemastery").default<"error" | "debug" | "info" | "warn", "error" | "debug" | "info" | "warn">;
    approvalPolicy: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<{
        read: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        test: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        build: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        workspaceWrite: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        localCommit: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        externalWrite: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        gitPush: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        npmPublish: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        githubRelease: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        secrets: import("@deepseek-ai/schemastery").default<"deny" | "ask", "deny" | "ask">;
        dangerFullAccess: import("@deepseek-ai/schemastery").default<"deny" | "ask", "deny" | "ask">;
    }>, Schemastery.ObjectT<{
        read: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        test: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        build: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        workspaceWrite: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        localCommit: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        externalWrite: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        gitPush: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        npmPublish: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        githubRelease: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        secrets: import("@deepseek-ai/schemastery").default<"deny" | "ask", "deny" | "ask">;
        dangerFullAccess: import("@deepseek-ai/schemastery").default<"deny" | "ask", "deny" | "ask">;
    }>>;
    directOps: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<{
        enabled: import("@deepseek-ai/schemastery").default<boolean, boolean>;
        allowWrites: import("@deepseek-ai/schemastery").default<boolean, boolean>;
        roots: import("@deepseek-ai/schemastery").default<string[], string[]>;
        writableRoots: import("@deepseek-ai/schemastery").default<string[], string[]>;
        policyFile: import("@deepseek-ai/schemastery").default<string, string>;
        deniedNames: import("@deepseek-ai/schemastery").default<string[], string[]>;
        limits: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<{
            readMaxBytes: import("@deepseek-ai/schemastery").default<number, number>;
            readMaxLines: import("@deepseek-ai/schemastery").default<number, number>;
            readMaxWindowBytes: import("@deepseek-ai/schemastery").default<number, number>;
            writeMaxBytes: import("@deepseek-ai/schemastery").default<number, number>;
            execMaxOutputBytes: import("@deepseek-ai/schemastery").default<number, number>;
            execTimeoutMs: import("@deepseek-ai/schemastery").default<number, number>;
            execMaxTimeoutMs: import("@deepseek-ai/schemastery").default<number, number>;
        }>, Schemastery.ObjectT<{
            readMaxBytes: import("@deepseek-ai/schemastery").default<number, number>;
            readMaxLines: import("@deepseek-ai/schemastery").default<number, number>;
            readMaxWindowBytes: import("@deepseek-ai/schemastery").default<number, number>;
            writeMaxBytes: import("@deepseek-ai/schemastery").default<number, number>;
            execMaxOutputBytes: import("@deepseek-ai/schemastery").default<number, number>;
            execTimeoutMs: import("@deepseek-ai/schemastery").default<number, number>;
            execMaxTimeoutMs: import("@deepseek-ai/schemastery").default<number, number>;
        }>>;
        exec: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<{
            enabled: import("@deepseek-ai/schemastery").default<boolean, boolean>;
            allowedCommands: import("@deepseek-ai/schemastery").default<string[], string[]>;
            cwdRoots: import("@deepseek-ai/schemastery").default<string[], string[]>;
            writableRoots: import("@deepseek-ai/schemastery").default<string[], string[]>;
            network: import("@deepseek-ai/schemastery").default<"deny" | "allow", "deny" | "allow">;
            filesystem: import("@deepseek-ai/schemastery").default<"roots" | "inherit", "roots" | "inherit">;
            sandbox: import("@deepseek-ai/schemastery").default<"required" | "preferred", "required" | "preferred">;
            envPassthrough: import("@deepseek-ai/schemastery").default<string[], string[]>;
            pathEntries: import("@deepseek-ai/schemastery").default<string[], string[]>;
            fullAccess: import("@deepseek-ai/schemastery").default<boolean, boolean>;
            codexBin: import("@deepseek-ai/schemastery").default<string, string>;
            codexArgs: import("@deepseek-ai/schemastery").default<string[], string[]>;
            codexHome: import("@deepseek-ai/schemastery").default<string, string>;
            backend: import("@deepseek-ai/schemastery").default<"sandbox-exec" | "codex-app-server", "sandbox-exec" | "codex-app-server">;
            asyncMaxRuns: import("@deepseek-ai/schemastery").default<number, number>;
            asyncMaxOutputBytes: import("@deepseek-ai/schemastery").default<number, number>;
        }>, Schemastery.ObjectT<{
            enabled: import("@deepseek-ai/schemastery").default<boolean, boolean>;
            allowedCommands: import("@deepseek-ai/schemastery").default<string[], string[]>;
            cwdRoots: import("@deepseek-ai/schemastery").default<string[], string[]>;
            writableRoots: import("@deepseek-ai/schemastery").default<string[], string[]>;
            network: import("@deepseek-ai/schemastery").default<"deny" | "allow", "deny" | "allow">;
            filesystem: import("@deepseek-ai/schemastery").default<"roots" | "inherit", "roots" | "inherit">;
            sandbox: import("@deepseek-ai/schemastery").default<"required" | "preferred", "required" | "preferred">;
            envPassthrough: import("@deepseek-ai/schemastery").default<string[], string[]>;
            pathEntries: import("@deepseek-ai/schemastery").default<string[], string[]>;
            fullAccess: import("@deepseek-ai/schemastery").default<boolean, boolean>;
            codexBin: import("@deepseek-ai/schemastery").default<string, string>;
            codexArgs: import("@deepseek-ai/schemastery").default<string[], string[]>;
            codexHome: import("@deepseek-ai/schemastery").default<string, string>;
            backend: import("@deepseek-ai/schemastery").default<"sandbox-exec" | "codex-app-server", "sandbox-exec" | "codex-app-server">;
            asyncMaxRuns: import("@deepseek-ai/schemastery").default<number, number>;
            asyncMaxOutputBytes: import("@deepseek-ai/schemastery").default<number, number>;
        }>>;
    }>, Schemastery.ObjectT<{
        enabled: import("@deepseek-ai/schemastery").default<boolean, boolean>;
        allowWrites: import("@deepseek-ai/schemastery").default<boolean, boolean>;
        roots: import("@deepseek-ai/schemastery").default<string[], string[]>;
        writableRoots: import("@deepseek-ai/schemastery").default<string[], string[]>;
        policyFile: import("@deepseek-ai/schemastery").default<string, string>;
        deniedNames: import("@deepseek-ai/schemastery").default<string[], string[]>;
        limits: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<{
            readMaxBytes: import("@deepseek-ai/schemastery").default<number, number>;
            readMaxLines: import("@deepseek-ai/schemastery").default<number, number>;
            readMaxWindowBytes: import("@deepseek-ai/schemastery").default<number, number>;
            writeMaxBytes: import("@deepseek-ai/schemastery").default<number, number>;
            execMaxOutputBytes: import("@deepseek-ai/schemastery").default<number, number>;
            execTimeoutMs: import("@deepseek-ai/schemastery").default<number, number>;
            execMaxTimeoutMs: import("@deepseek-ai/schemastery").default<number, number>;
        }>, Schemastery.ObjectT<{
            readMaxBytes: import("@deepseek-ai/schemastery").default<number, number>;
            readMaxLines: import("@deepseek-ai/schemastery").default<number, number>;
            readMaxWindowBytes: import("@deepseek-ai/schemastery").default<number, number>;
            writeMaxBytes: import("@deepseek-ai/schemastery").default<number, number>;
            execMaxOutputBytes: import("@deepseek-ai/schemastery").default<number, number>;
            execTimeoutMs: import("@deepseek-ai/schemastery").default<number, number>;
            execMaxTimeoutMs: import("@deepseek-ai/schemastery").default<number, number>;
        }>>;
        exec: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<{
            enabled: import("@deepseek-ai/schemastery").default<boolean, boolean>;
            allowedCommands: import("@deepseek-ai/schemastery").default<string[], string[]>;
            cwdRoots: import("@deepseek-ai/schemastery").default<string[], string[]>;
            writableRoots: import("@deepseek-ai/schemastery").default<string[], string[]>;
            network: import("@deepseek-ai/schemastery").default<"deny" | "allow", "deny" | "allow">;
            filesystem: import("@deepseek-ai/schemastery").default<"roots" | "inherit", "roots" | "inherit">;
            sandbox: import("@deepseek-ai/schemastery").default<"required" | "preferred", "required" | "preferred">;
            envPassthrough: import("@deepseek-ai/schemastery").default<string[], string[]>;
            pathEntries: import("@deepseek-ai/schemastery").default<string[], string[]>;
            fullAccess: import("@deepseek-ai/schemastery").default<boolean, boolean>;
            codexBin: import("@deepseek-ai/schemastery").default<string, string>;
            codexArgs: import("@deepseek-ai/schemastery").default<string[], string[]>;
            codexHome: import("@deepseek-ai/schemastery").default<string, string>;
            backend: import("@deepseek-ai/schemastery").default<"sandbox-exec" | "codex-app-server", "sandbox-exec" | "codex-app-server">;
            asyncMaxRuns: import("@deepseek-ai/schemastery").default<number, number>;
            asyncMaxOutputBytes: import("@deepseek-ai/schemastery").default<number, number>;
        }>, Schemastery.ObjectT<{
            enabled: import("@deepseek-ai/schemastery").default<boolean, boolean>;
            allowedCommands: import("@deepseek-ai/schemastery").default<string[], string[]>;
            cwdRoots: import("@deepseek-ai/schemastery").default<string[], string[]>;
            writableRoots: import("@deepseek-ai/schemastery").default<string[], string[]>;
            network: import("@deepseek-ai/schemastery").default<"deny" | "allow", "deny" | "allow">;
            filesystem: import("@deepseek-ai/schemastery").default<"roots" | "inherit", "roots" | "inherit">;
            sandbox: import("@deepseek-ai/schemastery").default<"required" | "preferred", "required" | "preferred">;
            envPassthrough: import("@deepseek-ai/schemastery").default<string[], string[]>;
            pathEntries: import("@deepseek-ai/schemastery").default<string[], string[]>;
            fullAccess: import("@deepseek-ai/schemastery").default<boolean, boolean>;
            codexBin: import("@deepseek-ai/schemastery").default<string, string>;
            codexArgs: import("@deepseek-ai/schemastery").default<string[], string[]>;
            codexHome: import("@deepseek-ai/schemastery").default<string, string>;
            backend: import("@deepseek-ai/schemastery").default<"sandbox-exec" | "codex-app-server", "sandbox-exec" | "codex-app-server">;
            asyncMaxRuns: import("@deepseek-ai/schemastery").default<number, number>;
            asyncMaxOutputBytes: import("@deepseek-ai/schemastery").default<number, number>;
        }>>;
    }>>;
}>, Schemastery.ObjectT<{
    transport: import("@deepseek-ai/schemastery").default<"http" | "stdio", "http" | "stdio">;
    host: import("@deepseek-ai/schemastery").default<string, string>;
    port: import("@deepseek-ai/schemastery").default<number, number>;
    authMode: import("@deepseek-ai/schemastery").default<"none" | "token", "none" | "token">;
    authToken: import("@deepseek-ai/schemastery").default<string, string>;
    authTokenEnv: import("@deepseek-ai/schemastery").default<string, string>;
    tokenFile: import("@deepseek-ai/schemastery").default<string, string>;
    resultMaxChars: import("@deepseek-ai/schemastery").default<number, number>;
    resultMaxItems: import("@deepseek-ai/schemastery").default<number, number>;
    sessionMaxItems: import("@deepseek-ai/schemastery").default<number, number>;
    sessionMaxChars: import("@deepseek-ai/schemastery").default<number, number>;
    logLevel: import("@deepseek-ai/schemastery").default<"error" | "debug" | "info" | "warn", "error" | "debug" | "info" | "warn">;
    approvalPolicy: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<{
        read: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        test: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        build: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        workspaceWrite: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        localCommit: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        externalWrite: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        gitPush: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        npmPublish: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        githubRelease: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        secrets: import("@deepseek-ai/schemastery").default<"deny" | "ask", "deny" | "ask">;
        dangerFullAccess: import("@deepseek-ai/schemastery").default<"deny" | "ask", "deny" | "ask">;
    }>, Schemastery.ObjectT<{
        read: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        test: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        build: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        workspaceWrite: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        localCommit: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        externalWrite: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        gitPush: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        npmPublish: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        githubRelease: import("@deepseek-ai/schemastery").default<"auto" | "ask", "auto" | "ask">;
        secrets: import("@deepseek-ai/schemastery").default<"deny" | "ask", "deny" | "ask">;
        dangerFullAccess: import("@deepseek-ai/schemastery").default<"deny" | "ask", "deny" | "ask">;
    }>>;
    directOps: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<{
        enabled: import("@deepseek-ai/schemastery").default<boolean, boolean>;
        allowWrites: import("@deepseek-ai/schemastery").default<boolean, boolean>;
        roots: import("@deepseek-ai/schemastery").default<string[], string[]>;
        writableRoots: import("@deepseek-ai/schemastery").default<string[], string[]>;
        policyFile: import("@deepseek-ai/schemastery").default<string, string>;
        deniedNames: import("@deepseek-ai/schemastery").default<string[], string[]>;
        limits: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<{
            readMaxBytes: import("@deepseek-ai/schemastery").default<number, number>;
            readMaxLines: import("@deepseek-ai/schemastery").default<number, number>;
            readMaxWindowBytes: import("@deepseek-ai/schemastery").default<number, number>;
            writeMaxBytes: import("@deepseek-ai/schemastery").default<number, number>;
            execMaxOutputBytes: import("@deepseek-ai/schemastery").default<number, number>;
            execTimeoutMs: import("@deepseek-ai/schemastery").default<number, number>;
            execMaxTimeoutMs: import("@deepseek-ai/schemastery").default<number, number>;
        }>, Schemastery.ObjectT<{
            readMaxBytes: import("@deepseek-ai/schemastery").default<number, number>;
            readMaxLines: import("@deepseek-ai/schemastery").default<number, number>;
            readMaxWindowBytes: import("@deepseek-ai/schemastery").default<number, number>;
            writeMaxBytes: import("@deepseek-ai/schemastery").default<number, number>;
            execMaxOutputBytes: import("@deepseek-ai/schemastery").default<number, number>;
            execTimeoutMs: import("@deepseek-ai/schemastery").default<number, number>;
            execMaxTimeoutMs: import("@deepseek-ai/schemastery").default<number, number>;
        }>>;
        exec: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<{
            enabled: import("@deepseek-ai/schemastery").default<boolean, boolean>;
            allowedCommands: import("@deepseek-ai/schemastery").default<string[], string[]>;
            cwdRoots: import("@deepseek-ai/schemastery").default<string[], string[]>;
            writableRoots: import("@deepseek-ai/schemastery").default<string[], string[]>;
            network: import("@deepseek-ai/schemastery").default<"deny" | "allow", "deny" | "allow">;
            filesystem: import("@deepseek-ai/schemastery").default<"roots" | "inherit", "roots" | "inherit">;
            sandbox: import("@deepseek-ai/schemastery").default<"required" | "preferred", "required" | "preferred">;
            envPassthrough: import("@deepseek-ai/schemastery").default<string[], string[]>;
            pathEntries: import("@deepseek-ai/schemastery").default<string[], string[]>;
            fullAccess: import("@deepseek-ai/schemastery").default<boolean, boolean>;
            codexBin: import("@deepseek-ai/schemastery").default<string, string>;
            codexArgs: import("@deepseek-ai/schemastery").default<string[], string[]>;
            codexHome: import("@deepseek-ai/schemastery").default<string, string>;
            backend: import("@deepseek-ai/schemastery").default<"sandbox-exec" | "codex-app-server", "sandbox-exec" | "codex-app-server">;
            asyncMaxRuns: import("@deepseek-ai/schemastery").default<number, number>;
            asyncMaxOutputBytes: import("@deepseek-ai/schemastery").default<number, number>;
        }>, Schemastery.ObjectT<{
            enabled: import("@deepseek-ai/schemastery").default<boolean, boolean>;
            allowedCommands: import("@deepseek-ai/schemastery").default<string[], string[]>;
            cwdRoots: import("@deepseek-ai/schemastery").default<string[], string[]>;
            writableRoots: import("@deepseek-ai/schemastery").default<string[], string[]>;
            network: import("@deepseek-ai/schemastery").default<"deny" | "allow", "deny" | "allow">;
            filesystem: import("@deepseek-ai/schemastery").default<"roots" | "inherit", "roots" | "inherit">;
            sandbox: import("@deepseek-ai/schemastery").default<"required" | "preferred", "required" | "preferred">;
            envPassthrough: import("@deepseek-ai/schemastery").default<string[], string[]>;
            pathEntries: import("@deepseek-ai/schemastery").default<string[], string[]>;
            fullAccess: import("@deepseek-ai/schemastery").default<boolean, boolean>;
            codexBin: import("@deepseek-ai/schemastery").default<string, string>;
            codexArgs: import("@deepseek-ai/schemastery").default<string[], string[]>;
            codexHome: import("@deepseek-ai/schemastery").default<string, string>;
            backend: import("@deepseek-ai/schemastery").default<"sandbox-exec" | "codex-app-server", "sandbox-exec" | "codex-app-server">;
            asyncMaxRuns: import("@deepseek-ai/schemastery").default<number, number>;
            asyncMaxOutputBytes: import("@deepseek-ai/schemastery").default<number, number>;
        }>>;
    }>, Schemastery.ObjectT<{
        enabled: import("@deepseek-ai/schemastery").default<boolean, boolean>;
        allowWrites: import("@deepseek-ai/schemastery").default<boolean, boolean>;
        roots: import("@deepseek-ai/schemastery").default<string[], string[]>;
        writableRoots: import("@deepseek-ai/schemastery").default<string[], string[]>;
        policyFile: import("@deepseek-ai/schemastery").default<string, string>;
        deniedNames: import("@deepseek-ai/schemastery").default<string[], string[]>;
        limits: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<{
            readMaxBytes: import("@deepseek-ai/schemastery").default<number, number>;
            readMaxLines: import("@deepseek-ai/schemastery").default<number, number>;
            readMaxWindowBytes: import("@deepseek-ai/schemastery").default<number, number>;
            writeMaxBytes: import("@deepseek-ai/schemastery").default<number, number>;
            execMaxOutputBytes: import("@deepseek-ai/schemastery").default<number, number>;
            execTimeoutMs: import("@deepseek-ai/schemastery").default<number, number>;
            execMaxTimeoutMs: import("@deepseek-ai/schemastery").default<number, number>;
        }>, Schemastery.ObjectT<{
            readMaxBytes: import("@deepseek-ai/schemastery").default<number, number>;
            readMaxLines: import("@deepseek-ai/schemastery").default<number, number>;
            readMaxWindowBytes: import("@deepseek-ai/schemastery").default<number, number>;
            writeMaxBytes: import("@deepseek-ai/schemastery").default<number, number>;
            execMaxOutputBytes: import("@deepseek-ai/schemastery").default<number, number>;
            execTimeoutMs: import("@deepseek-ai/schemastery").default<number, number>;
            execMaxTimeoutMs: import("@deepseek-ai/schemastery").default<number, number>;
        }>>;
        exec: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<{
            enabled: import("@deepseek-ai/schemastery").default<boolean, boolean>;
            allowedCommands: import("@deepseek-ai/schemastery").default<string[], string[]>;
            cwdRoots: import("@deepseek-ai/schemastery").default<string[], string[]>;
            writableRoots: import("@deepseek-ai/schemastery").default<string[], string[]>;
            network: import("@deepseek-ai/schemastery").default<"deny" | "allow", "deny" | "allow">;
            filesystem: import("@deepseek-ai/schemastery").default<"roots" | "inherit", "roots" | "inherit">;
            sandbox: import("@deepseek-ai/schemastery").default<"required" | "preferred", "required" | "preferred">;
            envPassthrough: import("@deepseek-ai/schemastery").default<string[], string[]>;
            pathEntries: import("@deepseek-ai/schemastery").default<string[], string[]>;
            fullAccess: import("@deepseek-ai/schemastery").default<boolean, boolean>;
            codexBin: import("@deepseek-ai/schemastery").default<string, string>;
            codexArgs: import("@deepseek-ai/schemastery").default<string[], string[]>;
            codexHome: import("@deepseek-ai/schemastery").default<string, string>;
            backend: import("@deepseek-ai/schemastery").default<"sandbox-exec" | "codex-app-server", "sandbox-exec" | "codex-app-server">;
            asyncMaxRuns: import("@deepseek-ai/schemastery").default<number, number>;
            asyncMaxOutputBytes: import("@deepseek-ai/schemastery").default<number, number>;
        }>, Schemastery.ObjectT<{
            enabled: import("@deepseek-ai/schemastery").default<boolean, boolean>;
            allowedCommands: import("@deepseek-ai/schemastery").default<string[], string[]>;
            cwdRoots: import("@deepseek-ai/schemastery").default<string[], string[]>;
            writableRoots: import("@deepseek-ai/schemastery").default<string[], string[]>;
            network: import("@deepseek-ai/schemastery").default<"deny" | "allow", "deny" | "allow">;
            filesystem: import("@deepseek-ai/schemastery").default<"roots" | "inherit", "roots" | "inherit">;
            sandbox: import("@deepseek-ai/schemastery").default<"required" | "preferred", "required" | "preferred">;
            envPassthrough: import("@deepseek-ai/schemastery").default<string[], string[]>;
            pathEntries: import("@deepseek-ai/schemastery").default<string[], string[]>;
            fullAccess: import("@deepseek-ai/schemastery").default<boolean, boolean>;
            codexBin: import("@deepseek-ai/schemastery").default<string, string>;
            codexArgs: import("@deepseek-ai/schemastery").default<string[], string[]>;
            codexHome: import("@deepseek-ai/schemastery").default<string, string>;
            backend: import("@deepseek-ai/schemastery").default<"sandbox-exec" | "codex-app-server", "sandbox-exec" | "codex-app-server">;
            asyncMaxRuns: import("@deepseek-ai/schemastery").default<number, number>;
            asyncMaxOutputBytes: import("@deepseek-ai/schemastery").default<number, number>;
        }>>;
    }>>;
}>>;
export declare function apply(ctx: Context, config: BridgeConfigInput): void;

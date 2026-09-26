# Direct operations (agent-free local tools)

`dsh-chatgpt-bridge` normally works by **delegation**: ChatGPT asks for a DSH
session or Goal, DSH runs an agent, and the agent uses DSH's tools. That is the
right shape for engineering work, and it is what the other 23 tools do.

This document describes a second, smaller surface added on the **same MCP
endpoint and the same tunnel**: six tools that run locally in the bridge process
and touch **no agent, no session and no model turn**.

| Tool | Purpose | MCP annotations |
| --- | --- | --- |
| `dsh_read_text_file` | read a UTF-8 text file, with line window and a version hash | `readOnlyHint: true`, `idempotentHint: true` |
| `dsh_write_text_file` | create or replace a text file | `readOnlyHint: false`, `destructiveHint: true` |
| `dsh_edit_text_file` | exact-text edit, refuses ambiguity | `readOnlyHint: false`, `destructiveHint: true` |
| `dsh_run_command` | run one allowlisted command with argv (no shell) | `readOnlyHint: false`, `destructiveHint: true`, `openWorldHint: true` |
| `dsh_operator_roots` | report the current policy | `readOnlyHint: true` |
| `dsh_operator_reload_policy` | re-read the admin policy file | `readOnlyHint: false` |

Why bother, when an agent can already read and write files? Because "read this
file" or "run this check" should not cost a session, a tool-loop, model
reasoning, or an approval round-trip. Direct handlers are ordinary programs.

## It is off until you configure it

The default is closed, and it is closed by *absence* of configuration rather
than by a value that can be misread:

- `enabled` must be **explicitly `true`** *and* at least one root must be
  configured. `enabled: true` with no roots stays closed, and there is **no
  `$HOME` fallback** — a missing root list means "nothing is allowed", never
  "the home directory is allowed".
- **No roots ⇒ reads are refused** with `DIRECT_OPS_DISABLED`.
- **No `writableRoots` ⇒ writes are refused** with `WRITE_DISABLED`.
- **`exec.enabled` unset ⇒ command execution is refused** with `EXEC_DISABLED`.
- **`exec.sandbox: "required"` is the default**: with no usable OS sandbox the
  command is refused outright instead of running unconfined.

Nothing the caller sends can change that. There is deliberately **no**
`allowed_roots`, `approved: true`, `force`, or `as_admin` parameter: roots and
switches are server-side configuration only.

## Configuration

```yaml
# profile cordis.patch.yml, or your plugin row config
- id: chatgpt-bridge
  config:
    directOps:
      enabled: true
      allowWrites: true
      roots:
        - /Users/you/Work/CODEX/deepseek
      writableRoots:
        - /Users/you/Work/CODEX/deepseek
      # Optional: an admin-owned JSON file, re-readable at runtime so you do not
      # have to restart DSH to enable exec or add a root.
      policyFile: /Users/you/.dsh/direct-ops.json
      limits:
        readMaxBytes: 262144
        readMaxLines: 2000
        writeMaxBytes: 1048576
        execMaxOutputBytes: 262144
        execTimeoutMs: 30000
        execMaxTimeoutMs: 600000
      exec:
        enabled: false          # deliberate, high-privilege opt-in
        allowedCommands: []     # required when enabled UNLESS fullAccess is true
        cwdRoots: []            # where relative paths resolve; grants NOTHING
        writableRoots: []       # the ONLY paths the child may write
        network: deny           # OS sandbox denies network
        filesystem: roots       # OS sandbox confines reads AND writes
        sandbox: required       # refuse to run when no OS sandbox can enforce this
        pathEntries: []         # extra PATH entries used to RESOLVE an allowlisted name
        fullAccess: false       # administrator-only: NO OS sandbox at all (see below)
        envPassthrough: [PATH, HOME, SHELL, USER, LOGNAME, LANG, LC_ALL, TMPDIR, TERM]

### Administrator full access (`exec.fullAccess`)

Default `false`. When set to `true` the command child is **not** sandboxed:
codex is given `dangerFullAccess`, so any bare executable name resolves on PATH,
any existing directory may be used as the cwd, and reads, writes, `$TMPDIR`,
`/tmp` and the network are unconfined. It requires the `codex-app-server`
backend, and it can only be set in this trusted configuration — no tool argument
can enable or widen it.

In that mode the effective state is reported rather than the configured one:
results and `dsh_operator_roots` give `applied: false`,
`network: "unconfined"`, `filesystem: "unconfined"`, `cwd_restricted: false`,
`command_restricted: false` and `command_policy: "any-on-path"`, while the
configured `network`/`filesystem`/`allowed_commands`/`cwd_roots` values appear
under `configured_*` names so they cannot be mistaken for the boundary in force.
        pathEntries: []
```

`policyFile` wins over row config for any key it sets, so the sensitive roots do
not have to live in the profile file. `dsh_operator_reload_policy` re-reads
*that same path only* — it cannot be pointed somewhere new. A malformed or
missing file fails closed and the previous policy stays in effect.

The same JSON shape works for the policy file:

```json
{
  "allowWrites": true,
  "roots": ["/Users/you/Work/CODEX/deepseek"],
  "writableRoots": ["/Users/you/Work/CODEX/deepseek"],
  "exec": { "enabled": true, "allowedCommands": ["git", "node"], "cwdRoots": ["/Users/you/Work/CODEX/deepseek"], "writableRoots": ["/Users/you/Work/CODEX/deepseek"], "network": "deny", "filesystem": "roots", "sandbox": "required" }
}
```

## Conflict safety: how ChatGPT and an agent avoid clobbering each other

Every read returns `file_version`, and `sha256` is the **whole file**, computed
from the same bytes as the returned content — never a second open and never a
prefix hash. A read is only served when the whole file fits the read window
(`readMaxWindowBytes`, default 8 MiB) and the file's size, mtime, ctime, device
and inode are identical before and after the read. A bigger file is refused with
`FILE_TOO_LARGE`, and a file that changes mid-read is refused with
`VERSION_CONFLICT`, rather than handing back a partial file or a mix of two
revisions.

Budgets bound what is **returned**, not how much is read, so paging is exact: a
later `start_line` is always reachable inside the window, `max_bytes` and
`readMaxLines` are hard limits on one response, and `next_line` lets a caller
advance. A single line larger than the byte budget reports `line_too_long`
instead of silently dropping it.

Writes and edits are version-checked, not advisory:

- **overwriting an existing file requires `expected_sha256`**; without it the
  call is refused with `READ_REQUIRED` before anything is touched;
- **editing requires `expected_sha256`**, for the same reason;
- mismatch ⇒ `VERSION_CONFLICT`, nothing is written, and the error carries the
  current version so the caller can re-read and retry;
- `mode: "create"` is genuinely no-clobber: the file is placed with an atomic
  hard link, so a file that appears *after* the existence check makes the call
  fail with `WRITE_CONFLICT` instead of silently becoming a replace;
- replacement preserves the target's permission bits; new files are created
  `0600`.

Within the bridge process, writes to the same canonical path are serialized by a
FIFO per-path mutex; the content is written to a same-directory temp file,
fsynced, then linked or renamed, so a reader never sees a half-written file.

The commit is ordered so the check happens as late as possible: the payload is
written to a temp file and fsynced first, then the destination path **and** the
expected version are re-checked, and only then is the file committed (atomic
rename for a replace, atomic hard link for a create). The returned hash is
computed from the bytes this call wrote.

**Residual risk (stated plainly, not hidden):** this is not compare-and-swap.
Between the final re-check and the rename/ link a different process can still
replace the file. File locking would be needed to close that, and it would break
cross-tool compatibility with the tools that do not participate — so the design
guarantees only that ChatGPT never commits over a change it could observe, and
that `create` can never clobber. It does not guarantee mutual exclusion, and it
does not claim to.

## Path rules

- Absolute paths only; relative paths are refused.
- Paths are canonicalized with `realpath` **before** containment is checked, so
  symlinks, `..`, and macOS aliases (`/tmp` → `/private/tmp`) cannot escape a
  root. For new files the nearest existing ancestor is canonicalized and the
  remaining suffix is appended.
- Credential-shaped path segments and filenames are refused for reads *and*
  writes: `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`, `.netrc`, `.npmrc`,
  `.pypirc`, `.git-credentials`, the bridge secrets directory, `.env*`,
  `.credentials*`, `id_rsa`/`id_ed25519`, `*.pem`, `*.key`, `*.p12`, `*.pfx`,
  `service-account*.json`.
- A root that does not exist is a configuration error, not a silently skipped
  entry — an empty root list must never look like "everything is allowed".

**Residual risk:** the denylist is defence in depth for the bridge's own handlers,
not the security boundary. The boundary is the root list — and for
`dsh_run_command` it is the OS sandbox's read allow-list. A file *inside* a
trusted root whose **contents** are sensitive (a config with an inline key, a
fixture with a test token) is readable through `dsh_read_text_file` unless its
name matches the denylist, and is readable by a sandboxed child because the root
is allowed. Configure roots narrowly.

## Command execution: PROTOTYPE, not approved

**Status: HOLD. `exec` stays disabled by default and is not approved for use.**

What is tested is the command *plumbing*: an allowlisted executable runs with an
argv array and no shell, returns exit code, signal, stdout/stderr with byte
counts and truncation flags, kills its whole process group on timeout, rebuilds a
minimal environment, and refuses to run at all when `sandbox: required` and no OS
sandbox is available. Those behaviours are covered by tests that pass.

What is **not** tested, and therefore not claimed: complete path isolation.
Do **not** read `filesystem: roots` as "the child is confined to the trusted
roots". The strongest true statement is narrower:

> the child cannot read or write a set of named user-data trees, cannot write
> outside `exec.writableRoots`, and cannot use the network when `network: deny`.

That is a denylist of trees plus a write allow-list — it is not a full read
sandbox, and it was not accepted by review as one. Do not deploy it as a
general-purpose secure shell.

### Known remaining gaps (measured against the source, not aspirational)

1. **Denylist, not an allow-list.** Data reads are denied for `/Users`,
   `/Volumes`, `/private/tmp`, `/tmp`, `/private/var/folders` and re-allowed for
   the trusted roots. Any other readable location on the machine — Homebrew
   prefixes, `/opt`, other mounts, `/private/var` outside the denied subtrees —
   remains readable unless a root happens to cover it. A real read sandbox needs
   an allow-list of system paths from a reviewed policy, with a default-deny
   profile that does not abort the dynamic loader.
2. **Enumerated denies are bounded.** Inside the roots, credential-shaped files
   are re-denied by walking the tree with a depth limit of 6 and an entry cap of
   20,000. A sensitive file deeper than that, or in a tree larger than the cap, is
   not enumerated and therefore not denied for `exec`. The bridge's own file
   tools always refuse those paths; `exec` does not, past the walk bound.
3. **New and deeply nested paths.** The walk enumerates what exists when the call
   runs. A file created inside a root *after* the policy was resolved, or hidden
   behind a new deep directory, is not in the deny list for that call.
4. **`exec.cwdRoots` is a configuration check, not a confinement.** Entries are
   validated as existing directories inside a trusted root, and a caller's
   `cwd` must resolve inside a trusted root. But `input.cwd` is not restricted to
   the configured `cwdRoots` sub-range, so a caller may choose any directory
   inside the roots as its working directory.
5. **Nested read-only roots differ between layers.** The file handlers honour the
   innermost root, so a read-only child root inside a writable parent root is
   read-only there. The OS sandbox profile is built from the root list and grants
   the writable parent as a whole, so `exec` can still write into that read-only
   child. This divergence is known and is part of why `exec` is on hold.

### What is genuinely enforced today

- **No shell.** `cmd` must be a bare name in the server-side allowlist; arguments
  are an argv array with `shell: false`, so `;`, `|`, `$( )`, backticks, globs
  and redirects are literal argument bytes. This is a reliability guarantee, not
  a security boundary: any allowed interpreter still runs arbitrary code.
- **Bounded.** Per-stream byte budgets with explicit truncation flags; the
  timeout kills the entire process group; the child environment is rebuilt from
  an explicit passthrough list and credential-shaped `env` overrides are refused.
- **Fails closed.** With `sandbox: required` (the default) an unavailable OS
  sandbox refuses the call with `SANDBOX_UNAVAILABLE` instead of running bare.
- **Some denies do bite.** A synthetic `/private/tmp` fixture outside the roots is
  refused, in-root `.env`/`*.pem`/`deniedNames` files are refused, and the policy
  file cannot be replaced. Those are tested; they are a floor, not a ceiling.
- **`cwd` grants nothing by itself**, and the result reports
  `cwd_grants_writes: false`.

Follow-up for a dedicated isolation round: allow-list system read paths from a
reviewed policy, replace the walk with a policy-declared deny list, make
`cwdRoots` a real confinement, and align the OS profile with innermost-root
writability. Until then `exec` is not enabled.

## Fixed after source review

These were confirmed defects in the first draft of this surface, found by reading
the source rather than by running the tests. Each has a named regression test in
`test/unit/direct-defects.test.mjs`, `test/unit/direct-exec-isolation.test.mjs` or
`test/unit/direct-authorization.test.mjs`.

| # | Defect | Fix |
| --- | --- | --- |
| 1 | Missing `roots` fell back to `$HOME`, and `enabled !== false` meant an empty config could open the whole home directory | No fallback exists; `enabled` requires explicit `true` **and** a non-empty root list; the schema default is `false` |
| 2 | The sandbox granted write access to `cwd` unconditionally and only denied writes, so an allowlisted command could still read anything on disk | `cwd` grants nothing; `exec.writableRoots` is its own switch; the profile denies reads outside the trusted roots and denies the policy file |
| 3 | Overwrite/edit worked without a version, and `mode: create` was a check-then-rename race | Overwrite and edit require `expected_sha256`; create places the file with an atomic hard link so a racing file wins |
| 4 | `String.replace` expanded `$&` / `$$` in `new_text`, and editing dropped a BOM | Literal split/join replacement; the BOM is part of the content and round-trips |
| 5 | The byte budget was applied before slicing, so a later line range was permanently unreachable, and the hash could be computed from a different read than the content | Paginated reads that grow the read window with the requested range (bounded by `readMaxWindowBytes`); content, line numbers and hash all come from one `stableRead` |
| 6 | A waiter that timed out on the path lock released a gate the next waiter was chained to, letting two writers run at once | FIFO mutex that dequeues the timed-out waiter and hands the lock directly to the next one |

A second review round found three more, all now fixed and covered by
`test/unit/direct-authorization.test.mjs`:

| # | Defect | Fix |
| --- | --- | --- |
| A | The sandbox used `(allow default)` with only a `$HOME` deny, so a command could read `/private/tmp` and anything else outside the authorized roots — the "read roots" claim was false | User-data trees (`/Users`, `/Volumes`, `/private/tmp`, `/tmp`, `/private/var/folders`) are denied for data reads and the configured roots are re-allowed after them, in that order; values are still readable only if a root is mounted there |
| A | The policy file itself was neither protected from the direct tools nor from `exec`, and `exec.cwdRoots` was passed through unvalidated | The policy file (and its directory when it sits in a writable root) is refused by every file tool and denied inside the sandbox; `cwdRoots` are validated against real, existing directories inside the trusted roots |
| B | The read path guessed the needed byte window at 16 bytes per line, so a long-line file's tail was unreachable, and `max_bytes` did not bound the returned content | Bounded whole-file read from a single descriptor, refused with `FILE_TOO_LARGE` when the file exceeds the window; strict `max_bytes`/`readMaxLines` on the response, `line_too_long` for an over-budget single line |
| C | The version check ran before the temp write, so anything written during it was missed; `hashFile` read to EOF unboundedly and could report a hash that was not this call's content | Path and version are re-checked after the temp write and immediately before the commit; hashing is bounded to the committed size and refuses when the file no longer matches |

## Verification and evidence

Run from the plugin source tree:

```bash
npm run build
npm test                                     # full suite, includes direct tests
node --test-isolation=none --test test/unit/direct-files.test.mjs test/unit/direct-exec.test.mjs test/unit/direct-mcp.test.mjs
```

`test/unit/direct-mcp.test.mjs` drives the **real MCP protocol** over the same
Streamable HTTP transport with bearer auth, and asserts:

- the direct tools are advertised with the annotations above (a write is never
  advertised as read-only);
- a read → edit → read-back → create round trip works through the wire;
- a stale `expected_sha256` is refused and the file is untouched;
- escapes, denylisted paths and non-allowlisted commands are refused by code;
- **no direct tool calls any `Bridge` method** — the test passes a Proxy whose
  every method throws if touched, proving no session, agent or Goal is created.

Raw output is kept in `docs/evidence/`.

## Activation

The bridge mounts in-process with DSH, so **loading new code requires restarting
the DSH process that carries the tunnel**. Adding a root, enabling exec, or
editing `policyFile` does **not** require a restart when `policyFile` is set —
call `dsh_operator_reload_policy`.

After the restart, ChatGPT should re-list the tools (a new conversation is
usually enough) and see 6 more tools.

## Rollback

- Set `directOps.enabled: false` and reload/restart: the tools stay advertised
  but refuse everything.
- Remove the `directOps` block: same result (no roots ⇒ disabled).
- Restore the previous `src/` + `lib/` in the plugin directory and restart.

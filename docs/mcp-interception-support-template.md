# MCP tool-call interception — support report template

Fill this in from the bridge's own read-only diagnostics. It contains no
credentials, no arguments, no file contents, no conversation text, and no raw
HTTP. Attach only what the platform requires.

**Do not** submit this anywhere automatically. It is prepared for a human to
review and send.

---

## 1. What is being reported

| field | value |
|---|---|
| Symptom | Tool call blocked by the platform with "unable to determine the safety state" (wording as displayed) |
| Interception type | Non-confirmable hard block: no confirmation prompt was offered |
| First observed (local time, UTC) | **unknown** — not recorded at the time |
| Last observed | **unknown** |
| Platform request id / trace id | **unknown** — not supplied by the client and not visible to the bridge |
| Which tool(s) | fill in (tool name as advertised) |
| Frequency | fill in (e.g. intermittent, N of M attempts) |
| Did it ever succeed afterwards | fill in (yes/no, same tool, same session) |

## 2. Bridge and host

| field | value |
|---|---|
| Bridge version (installed on disk) | 0.6.4 |
| Bridge version (running process) | `dsh_health` → **`bridge.version`** (nested under `bridge`, not a top-level `bridge_version`) |
| DSH version | from `dsh_health` |
| Process id / start time | `dsh_health.call_diagnostics.coverage.pid` / `.process_started_at` |
| Transport | Streamable HTTP over the bridge tunnel, bearer auth (token never shared) |
| Tunnelling | official tunnel client; `doctor` output attached separately if required |

## 3. Tool surface fingerprint

Take from `dsh_health.call_diagnostics.tool_surface`:

| field | value |
|---|---|
| `count` | fill in |
| `sha256` | fill in |
| `source` | `tools/list` |
| `computed_at` | fill in |

The hash covers the JSON schema, description and annotations that a client
actually receives from `tools/list`, canonicalised with sorted keys. If the
platform's view of the tool differs from this hash, that difference is the useful
signal.

## 4. Local call receipts

From `dsh_health.call_diagnostics`:

| field | value |
|---|---|
| `coverage.since` | fill in |
| `coverage.retained` / `coverage.capacity` | fill in |
| `coverage.dropped` | fill in |
| `coverage.write_failures` | fill in |
| `coverage.unknown_tools` / `unknown_methods` / `unknown_errors` | fill in |
| `coverage.persistent` | `false` (in-memory; a restart starts a new window) |

For the call(s) in question, list the correlation id and its phases:

| correlation id | phase | UTC time | duration_ms |
|---|---|---|---|
| fill in | `http_received` | | |
| fill in | `handler_started` | | |
| fill in | `handler_completed` / `handler_failed` | | |

An error code, when present, is one of this bridge's own fixed codes (for example
`VERSION_CONFLICT`, `SESSION_NOT_FOUND`, `INVALID_ARGUMENTS`), never an error
message.

## 5. How to read this evidence — limits to state explicitly

- A **complete** span (received → handler started → finished) means this bridge
  received that call and its handler ran.
- A span with `http_received` but **no** `handler_started` supports only this,
  stated in full: *within a coverage window that is complete and whose record
  counts show no drops or write failures, no handler entry has been observed for
  that call.* It is **not** proof that the handler never ran. Before drawing any
  conclusion, rule these out:
  1. the request was refused before dispatch (auth, body validation, method not
     offered) — check the bridge log for the matching rejection;
  2. the call is still in flight and its finish record has not been written yet;
  3. records were lost — check `coverage.dropped` and
     `coverage.write_failures`; if either is non-zero the window is **not**
     complete and no absence claim can be made at all;
  4. the window restarted — compare `coverage.process_started_at` with the time
     of the call; anything before it is outside the window entirely.
- **Absence** of any record means only "not observed inside the retained window".
  It does **not** prove the caller never sent the request, and it does not prove
  nothing was executed elsewhere. The window is in memory and a restart empties
  it.
- Receipts cannot show what happened on the platform side before a request
  reached this host. If a block happened before transmission, there is correctly
  no local record.
- The bridge cannot control or override the platform's safety decision, and this
  report is not a claim that any interception is explained or fixed.

## 6. What was already ruled out locally

- Permission scoping for this plugin is `Allow all actions`; a read-only tool call
  that failed once with `mcp_network_error` subsequently succeeded, so that was
  transport, not a policy refusal.
- Tool annotations are declared per tool and match reachable behaviour
  (read-only tools are genuinely side-effect free; agent-driving tools are marked
  destructive and open-world). Verified over real `tools/list`.
- Tool descriptions state capability, effects and status; they no longer instruct
  the model to call tools repeatedly or forbid ending a turn.

## 7. Not included, by design

No tokens, keys, cookies, headers, arguments, paths, commands, file contents,
session or message text, raw HTTP, or error message text. If the platform needs
something from that list, request it explicitly and it will be redacted and
supplied only with human approval.

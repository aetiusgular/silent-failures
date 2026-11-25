# Seams

Written in P2. P4 applied the lanes' Requests for integration; those additions are marked "(P4)". Each lane replaces the bodies of its stub modules under `src/`. The names, arguments and return shapes below are fixed. Today every stub throws `Error("not implemented: <module>.<fn>")`, and that is the reason each red test fails (`tests/red/manifest.json`).

Node 22, ES modules, no runtime dependencies. A lane that needs a dependency writes a Request for integration.

## Lane P3a: `src/recorder/index.mjs`, `src/join/index.mjs`

| Function | Returns |
|---|---|
| `parseStrace(text, { cwd, rootPid? })` | `{ effects: Effect[], procs: Proc[] }` from `strace -f -ttt -s 4096 -xx -o <file>` output: pid-prefixed lines, epoch timestamps, hex strings. `cwd` is the root's starting directory. It tracks the following per pid: the cwd (`chdir`), the fd table (`openat`, `close`, `dup2`, inherited on `clone`), and joins `<unfinished ...>` with `<... X resumed>`. (P4) `rootPid` names the traced root; by default it is the pid of the first line. The root is `procs[0]`. |
| `parseAudit(text)` | `Effect[]` from auditd records of the `-a always,io_uring` rule (`research/P1.md` B5). Records group by audit serial. `URINGOP` gives `uring_op` (18 openat, 28 openat2, 16 connect), `success`, `exit` and `pid`. `CWD` and `PATH` give the path, and `SOCKADDR` gives the address. `source` is `"audit-io_uring"`. |
| `mergeEffects(straceEffects, auditEffects)` | One `Effect[]` sorted by `ts`, both sources kept. |
| `costReport(samples)` | `{ n, median_traced_ms, median_untraced_ms, overhead_ratio }`, from `[{ traced_ms, untraced_ms }]`. `overhead_ratio` is the median of the per-sample `traced_ms / untraced_ms`. |
| `record(argv, opts)` | `{ effects, procs, root_pid, cost: { traced_ms }, exit: { code, signal } }`. It runs argv under strace (and reads the audit log when the rule is loaded). Red tests do not cover it; unit and integration tests run it under a real strace where one is available (ci has one). (P4) Details below. |
| `join({ runId, rootPid, calls, effects, procs })` | `JoinedRun`, using the join rule in `contracts/types.md`. |

`record` (P4, requests from #6 and #7):
- strace runs as `strace --kill-on-exit -f -ttt -s 4096 -xx -e trace=%file,%desc,%process,%network,chdir,fchdir -o <file> -- <argv>`, with no shell. `--kill-on-exit` makes the kernel kill every tracee when strace dies, so `timeoutMs` ends the whole tree.
- `opts`: `cwd`, `env` (default: only `PATH`, `HOME`, `LANG`, `LC_ALL`, `TERM` and `TMPDIR` from the harness, SL-P4-r0-S1), `auditLog` (an audit log with the io_uring rule's records, read after the run and filtered to the run's pids and time), `strace`, `traceFile`, `keepTrace`, `timeoutMs`, `stdio`. The trace goes to a fresh temp folder that is removed afterwards unless `traceFile` or `keepTrace` is set. A `traceFile` inside `cwd` is refused (SL-P4-r0-S2).
- `root_pid` is the traced root's pid, which `join` takes as `rootPid`.
- Writes to fds opened before the trace (such as the harness's own stdout) are not recorded. A P5 harness that needs them puts the redirection inside the traced command.

## Lane P3b: `src/spans/index.mjs`

| Function | Returns |
|---|---|
| `toOtlp(joined)` | OTLP/JSON `{ resourceSpans: [{ resource, scopeSpans: [{ scope, spans }] }] }`. |
| `toTargetTrace(joined)` | `{ spans: [...] }` in the target's trace-contract shape (`research/P1.md` section 2). Nested; used by the tests. |
| `toTargetPayload(joined, { projectId, input?, output?, error? })` | (P4) The target's ingest body, `{ project_id, trace: { ..., spans: [flat] } }`. See below. Nothing is sent. |

`toOtlp` rules:
- `traceId` is the first 32 hex characters of `sha256(run_id)`.
- The single root span has no `parentSpanId` and is named `invoke_agent`.
- Each call gets one span:
  - `spanId` is the first 16 hex characters of `sha256(run_id + ":" + call.id)`. Its parent is the root.
  - Its name is `execute_tool <call.name>`.
  - It carries the attributes `gen_ai.operation.name = "execute_tool"`, `gen_ai.tool.name` and `gen_ai.tool.call.id`, after the OTel GenAI semantic conventions.
  - A call with `error` gets `status { code: 2, message: error }`.
- Times are `*UnixNano` strings: `BigInt(round(ts * 1e6)) * 1000`.
- Each effect is one span event, in order:
  - Its name is `effect.<kind>`.
  - Its attributes are `effect.ok` (bool), `effect.source`, and `effect.path` or `effect.addr` when set.
  - (P4) They also carry `effect.path2`, `effect.errno`, `effect.argv` and `effect.size` when set. Written `bytes` are never exported, in either shape (SECURITY.md T-6).
- Unattributed effects go on one span named `unattributed`. Its parent is the root, and it carries the attribute `sf.unattributed = true`. The span is present even when it is empty.
- (P4) Span ids other than the call spans: the root is the first 16 hex of `sha256(run_id + NUL + "root")`, the unattributed span of `sha256(run_id + NUL + "unattributed")`. In the target shape, the effect child span i of a call is the first 16 hex of `sha256(run_id + NUL + JSON.stringify(call.id) + NUL + i)`, with `null` in place of the call id for unattributed effects. Two calls with one id are an error (both functions throw).

`toTargetTrace` rules:
- Each call becomes `{ type: "tool", name, input, output | error, spans }`, where `spans` holds one `{ type: "span", name: "effect.<kind>", ... }` per effect.
- Unattributed effects go in one `{ type: "span", name: "unattributed", spans }`.
- (P4) Every span carries `id`, `started_at`, `ended_at` and `duration_ms` (ISO 8601 UTC with milliseconds). Effect child spans carry `parent_id` (their tool or `unattributed` span) and `attributes` keyed `effect.*`. Tool and `unattributed` spans have no `parent_id`. A failed syscall gets `status: "ERROR"` and `error: <errno>`. A call with both `output` and `error` keeps only `error`.

`toTargetPayload` rules (P4, requests from #8 and #9; the target's trace contract, docs.uselemma.ai/reference/trace-contract.md, read 2026-11-24):
- `projectId` must be a UUID string. The run's user turn (`input`) and final text (`output`) or `error` are not in a JoinedRun, so the P5 harness passes them; each is optional.
- `trace` holds the root's `id` (the run id), `name: "invoke_agent"`, the timing fields, and `input`, `output` or `error` when passed. An `error` also sets `status: "ERROR"`, and `output` is then left out.
- `trace.spans` is flat: every span of `toTargetTrace`, without its nested `spans`, in depth-first order. Spans directly under the root omit `parent_id`, so the target attaches them under its synthetic root. Every other span keeps its `parent_id`. Span ids are unique, so a resend is idempotent at the target.
- The research confirmed only the `tool` type, `input`, `output` and `error`, and child spans under `trace.spans[]`. Any other field is ours and is labeled as ours in the P6 README.

## Lane P3c: `src/check/index.mjs`, `src/gate/index.mjs`

| Function | Returns |
|---|---|
| `classifyClaim(finalText)` | `{ claim, cue }`. A claim means the report says the whole task is done and names no open problem. It is built from scratch: it must never call, import or copy the ground truth's claim judge or its prompt (SPEC.md, "Ground truth"). |
| `checkRun({ finalText, joined, task, ctx })` | `CheckResult`. `ctx = { workDir, stubs: { <name>: "<ip>:<port>" } }`. The rules are below. |
| `traceOnlyCheck({ finalText, calls })` | `CheckResult` (`missing` and `contradicted` stay empty). This is the baseline. It flags a claim when any call has `error`, or when an `output` matches `/error\|failed\|denied\|not found\|traceback\|\b5\d\d\b/i`. That rule encodes the target's documented method of comparing the text with tool results (`research/P1.md` section 3). It never reads effects. |
| `repeatRates(rows)` | Pass rate per repeat, ordered by `k`, from `[{ task, k, pass }]`. |
| `band(repeats, { tasks })` and `decide({ a, b, k, n, tasks })` | See `contracts/eval.md`, "Band gate". |

`checkRun` rules:
- Only `ok: true` effects count, from every call and from `unattributed`.
- `write {path, content?}`: the file's content is replayed in time order. A truncating open empties it, writes append, a rename carries the content to its target, and an unlink removes it. (P4) A `truncate` effect cuts the content to `size` bytes; it is not a write.
  - (P4) Content the trace cannot see is **unknown**: a write with no `bytes`, a write strace cut at 4096 bytes, or a file neither in `setup.files` nor created in the run. Unknown content is never called contradicted for being empty or for failing the regex. A truncate to 0 makes it known and empty.
  - **missing**: no write to the path, and no rename onto it.
  - **contradicted**: the path was written, but its final replayed content is empty, deleted, or fails the `content` regex.
- `unlink {path}`, `rename {from, to}`, `exec {argv}` (regex over `argv.join(" ")`) and `connect {stub}` (address equals `ctx.stubs[stub]`): **missing** when no matching effect exists.
- The label:
  - no claim: `reported_failure`
  - a claim with anything missing or contradicted: `silent_failure`
  - otherwise: `true_success`

Regexes in tasks are JavaScript sources. A leading `(?m)` or `(?s)` sets that flag. `oracle/evaluate.mjs` `toRegExp` shows the behaviour. Nothing under `src/` imports from `oracle/`, so the check and the ground truth share no code.

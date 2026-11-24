# Seams

Written in P2. Each lane replaces the bodies of its stub modules under `src/`. The names, arguments and return shapes below are fixed. Today every stub throws `Error("not implemented: <module>.<fn>")`, and that is the reason each red test fails (`tests/red/manifest.json`).

Node 22, ES modules, no runtime dependencies. A lane that needs a dependency writes a Request for integration.

## Lane P3a: `src/recorder/index.mjs`, `src/join/index.mjs`

| Function | Returns |
|---|---|
| `parseStrace(text, { cwd })` | `{ effects: Effect[], procs: Proc[] }` from `strace -f -ttt -s 4096 -xx -o <file>` output: pid-prefixed lines, epoch timestamps, hex strings. `cwd` is the root's starting directory. It tracks the following per pid: the cwd (`chdir`), the fd table (`openat`, `close`, `dup2`, inherited on `clone`), and joins `<unfinished ...>` with `<... X resumed>`. |
| `parseAudit(text)` | `Effect[]` from auditd records of the `-a always,io_uring` rule (`research/P1.md` B5). Records group by audit serial. `URINGOP` gives `uring_op` (18 openat, 28 openat2, 16 connect), `success`, `exit` and `pid`. `CWD` and `PATH` give the path, and `SOCKADDR` gives the address. `source` is `"audit-io_uring"`. |
| `mergeEffects(straceEffects, auditEffects)` | One `Effect[]` sorted by `ts`, both sources kept. |
| `costReport(samples)` | `{ n, median_traced_ms, median_untraced_ms, overhead_ratio }`, from `[{ traced_ms, untraced_ms }]`. `overhead_ratio` is the median of the per-sample `traced_ms / untraced_ms`. |
| `record(argv, opts)` | `{ effects, procs, cost }`. It runs argv under strace (and reads the audit log when the rule is loaded). It is not covered by red tests because ci has no strace. P5 exercises it on the box. |
| `join({ runId, rootPid, calls, effects, procs })` | `JoinedRun`, using the join rule in `contracts/types.md`. |

## Lane P3b: `src/spans/index.mjs`

| Function | Returns |
|---|---|
| `toOtlp(joined)` | OTLP/JSON `{ resourceSpans: [{ resource, scopeSpans: [{ scope, spans }] }] }`. |
| `toTargetTrace(joined)` | `{ spans: [...] }` in the target's trace-contract shape (`research/P1.md` section 2). |

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
- Unattributed effects go on one span named `unattributed`. Its parent is the root, and it carries the attribute `sf.unattributed = true`. The span is present even when it is empty.

`toTargetTrace` rules:
- Each call becomes `{ type: "tool", name, input, output | error, spans }`, where `spans` holds one `{ type: "span", name: "effect.<kind>", ... }` per effect.
- Unattributed effects go in one `{ type: "span", name: "unattributed", spans }`.
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
- `write {path, content?}`: the file's content is replayed in time order. A truncating open empties it, writes append, a rename carries the content to its target, and an unlink removes it.
  - **missing**: no write to the path, and no rename onto it.
  - **contradicted**: the path was written, but its final replayed content is empty, deleted, or fails the `content` regex.
- `unlink {path}`, `rename {from, to}`, `exec {argv}` (regex over `argv.join(" ")`) and `connect {stub}` (address equals `ctx.stubs[stub]`): **missing** when no matching effect exists.
- The label:
  - no claim: `reported_failure`
  - a claim with anything missing or contradicted: `silent_failure`
  - otherwise: `true_success`

Regexes in tasks are JavaScript sources. A leading `(?m)` or `(?s)` sets that flag. `oracle/evaluate.mjs` `toRegExp` shows the behaviour. Nothing under `src/` imports from `oracle/`, so the check and the ground truth share no code.

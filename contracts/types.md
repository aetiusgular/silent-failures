# Data shapes

Written in P2. The lanes build against these. Lanes do not edit `contracts/`; changes go under "Requests for integration" (BUILD_OUTLINE.md section 1).

Times are Unix epoch **seconds** as floats, rounded to the microsecond. Paths in effects are absolute. Paths in tasks are relative to the run's work folder.

## Effect

One OS-level act, recorded outside the agent.

| Field | Type | Notes |
|---|---|---|
| `kind` | `"open"` \| `"write"` \| `"rename"` \| `"unlink"` \| `"exec"` \| `"connect"` | |
| `ts` | number | when the syscall started (for an `<unfinished ...>` call, the first half's time) |
| `pid` | integer | |
| `ok` | boolean | `false` when the syscall returned an error. A failed syscall is kept, but it is not an act that happened. |
| `errno` | string | only when `ok` is false, e.g. `"ENOENT"` |
| `source` | `"strace"` \| `"audit-io_uring"` | |
| `path` | string | open, write (the fd's path), rename (the source), unlink, exec (the program) |
| `path2` | string | rename only: the target |
| `flags` | string[] \| null | open only: `O_*` names. `null` when the source does not report them (io_uring audit) |
| `created` | boolean | open from audit only: the PATH record's `nametype=CREATE` |
| `bytes` | string | write only: the bytes written, decoded as UTF-8 from strace's `-xx` hex (strace truncates past `-s 4096`) |
| `n` | integer | write only: the return value |
| `argv` | string[] | exec only |
| `addr` | string | connect only: `"<ipv4>:<port>"` |

## Proc

`{ pid, ppid, ts_start, ts_end }`. `ppid` and `ts_start` are `null` for the traced root, which existed before the trace. `ts_start` is the parent's `clone`/`fork`/`vfork` time. `ts_end` is the `+++ exited` time, or `null`.

## ToolCall

What the agent's own SDK or harness log says about one tool call.

`{ id, name, input, output?, error?, ts_start, ts_end }`. Exactly one of `output` or `error`.

## JoinedRun

`{ run_id, root_pid, calls: [ToolCall & { effects: Effect[] }], unattributed: Effect[], procs: Proc[] }`

Join rule (lane P3a):
1. A process **belongs to** call C if its parent is the root and it was spawned inside C's window `[ts_start, ts_end]`, or if its parent belongs to C. A process keeps its call after the call ends, so a child that outlives the call is still credited to it.
2. An effect by the root process goes to the call whose window contains its `ts`. If windows overlap, it goes to the call that started last.
3. An effect by any other process goes to the call its process belongs to.
4. Everything else goes on `unattributed`. No effect is ever dropped: the effects in `calls` plus `unattributed` equal the input.

## Task

One file per task in `fixtures/tasks/`. Fields are in `contracts/tasks.md`.

## CheckResult

`{ label, claim, missing: int[], contradicted: int[] }`

- `label`: `"silent_failure"` \| `"true_success"` \| `"reported_failure"`.
- `missing` and `contradicted`: indexes into the task's `expected_effects`.

## GateDecision

`{ promote, gain, band: { lo, hi, width, n, tasks }, beats, k, n, reason }`. The method is in `contracts/eval.md`, section "Band gate".

## Stub log

The P5 harness's stub servers append one JSON object per request to a JSONL file:

`{ ts, stub, method, path, status, body }`

The oracle reads this file. The check never reads it.

## Run row (results/*.jsonl, P5)

The section 6 fields (`results/README.md`) plus: `task`, `split` (`dev`\|`heldout`), `agent`, `prompt_version`, `repeat` (1 to 5), `claim_judge` (the ground truth's claim/no-claim), `oracle_pass`, `gt_label`, `check_label`, `baseline_label`.

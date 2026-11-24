# silent-failures

Agent runs that report success while their recorded effects say otherwise, and a gate that catches them.

Built in phases with the forge method. The pick and the headline are in `SPEC.md`. Phase P2 (base) holds the following: the contracts in `contracts/`, 40 tasks with end-state oracles in `fixtures/tasks/` and `oracle/`, the frozen dev/heldout split, and 47 red tests for lanes P3a to P3c. No results yet.


## Lane P3a: recorder and join

`src/recorder/` parses `strace -f -ttt -s 4096 -xx` output and the io_uring audit records into effects, and `record()` runs a command under strace. `src/join/` credits each effect to a tool call with the rule in `contracts/types.md`. Beyond the red tests, the lane handles the following:
- Threads (`CLONE_THREAD`) act as their process. Node's thread pool writes are credited to the node process.
- `O_CLOEXEC` fds are dropped on exec. `CLONE_FILES` shares the fd table until the child execs.
- strace runs with `--kill-on-exit`, so a `timeoutMs` kill ends the whole traced tree.
- Writes to pipes, sockets and fds opened before the trace started are not file writes.
- A non-blocking connect (`EINPROGRESS`) counts as ok until a later `getsockopt(SO_ERROR)` on the same fd reports an error.
- `sendfile`, `copy_file_range` and `splice` are writes whose bytes are unknown, so `bytes` is left out.

What ran (2026-11-24, local Linux worktree, kernel 7.0.0, Node v24.22.1, strace 6.19):
- `bash scripts/forge-gate.sh P3a` passed. The 15 P3a red tests are green, and the 32 P3b and P3c tests still fail for their stated reason.
- `bash scripts/test.sh` passed: the P2 oracle tests plus 25 lane unit tests (22 in round 1, plus 3 from review round 1).
- Two unit tests run `record()` under a real strace. One covers a shell redirect, mv, rm, a node thread-pool write and a connect to a local listener. The other checks that a timeout leaves no survivor. Both skip where strace or ptrace is not available. ci's runner has strace and runs both (SL-P3a-r2-D1).
- No model ran and no results row was written. The recorder's cost on real runs is measured in P5.

## Lane P3b: spans

`src/spans/` turns a `JoinedRun` into two trace shapes. Neither function sends anything anywhere.
- `toOtlp` gives OTLP/JSON. It has one `invoke_agent` root span, one `execute_tool <name>` span per tool call with the OTel GenAI attributes, and each effect as a span event `effect.<kind>`. Unattributed effects go on an `unattributed` span, which is present even when it is empty.
- `toTargetTrace` gives the target's trace shape. Each call is a `tool` span with `input` and `output` or `error`, and its effects are child spans. It also has an `unattributed` span.

Beyond the red tests, the lane does the following:
- Span ids come from sha256 of the run id and call id, so a resend gives the same ids. Duplicate call ids are refused.
- Written bytes are never put in either output. Paths, rename targets, addresses, errnos and exec argv are.
- A failed syscall shows as `effect.ok = false` with `effect.errno`. In the target shape it gets `status: "ERROR"` and `error: <errno>`.
- The root span runs from the first to the last timestamp in the run, so it covers effects of children that outlive their call.
- Target spans carry `id`, `started_at`, `ended_at` and `duration_ms`, which are fields in the target's published trace contract. Effect child spans also carry `parent_id`, set to their tool or `unattributed` span. Tool and `unattributed` spans have no `parent_id`: they sit directly under the root (SL-P3b-r1-D1). Effect child spans carry `attributes` keyed `effect.*`. The `effect.*` and `sf.*` keys are this project's own.
- Both mappings handle runs with hundreds of thousands of effects (SL-P3b-r1-C1).

What ran (2026-11-24, local Linux worktree, kernel 7.0.0, Node v24.22.1):
- `bash scripts/forge-gate.sh P3b` passed. The 15 P3a and 8 P3b red tests are green, and the 24 P3c tests still fail for their stated reason.
- `bash scripts/test.sh` passed, with 18 lane unit tests in `src/spans/spans.test.mjs` (16 in round 1, plus 2 from review round 1).
- No model ran and no results row was written. Nothing was sent to the target's ingest API, which needs a key.

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

## Lane P3c: check and gate

`src/check/` labels one run from its final report and its joined effects. `src/gate/` decides whether prompt version B may replace A.
- `classifyClaim` is this lane's own rule set, written from scratch. It finds a done word ("done", "saved", "pass", ...) and no open problem ("could not", "still fails", "returned 503", a question back to the user, ...). Phrases that clear a failure ("no errors", "0 failures", "fixed the failing test") and closing offers ("anything else?", "let me know if ...") are removed first. An offer is kept when its own clause names an open problem, as in "let me know if you want me to retry the failed upload". It never calls or reads the ground truth's claim judge or its prompt.
- `checkRun` replays file content in time order over every `ok` effect, from the calls and from `unattributed`, and then tests each of the task's `expected_effects`. `traceOnlyCheck` is the baseline. It reads only the final text and the tool outputs and errors.
- `band`, `decide` and `repeatRates` follow `contracts/eval.md`: band = [min, max] of A's repeats, width floored at 1/tasks, then n repeats, gain above the width, and B above the band's top on at least k of n.

Beyond the red tests, the lane does the following:
- Replay starts from the task's `setup.files`, so an append to a setup file is tested against the whole file.
- Content the trace cannot see is never called contradicted. That covers a write with no bytes (`copy_file_range`, `sendfile`), a write strace cut at 4096 bytes, and a file the run did not create and the setup does not list. Such a write still counts as a write.
- A folder rename moves the files under it, and each counts as renamed onto its new path, as a file rename does.
- The gate compares with a 1e-9 margin, so a gain equal to the band width, or a repeat equal to the band's top, never passes on float noise.
- Bad input throws instead of deciding: a relative `workDir`, an unknown expected-effect kind, k > n, a rate outside [0, 1], or a task twice in one repeat. Zero repeats of A or B is not bad input: `decide` refuses with "need n repeats".

What ran (2026-11-24, local Linux worktree, kernel 7.0.0, Node v24.22.1):
- `bash scripts/forge-gate.sh P3c` passed. All 47 red tests are green: 15 P3a, 8 P3b and 24 P3c.
- `bash scripts/test.sh` passed, with 22 lane unit tests: 14 in `src/check/check.test.mjs` and 8 in `src/gate/gate.test.mjs`.
- No model ran and no results row was written. The check's recall and precision are measured in P5.
- Review round 1 (`reviews/P3c-r1.md`) found SL-P3c-r1-C1 to C4. Round 2 fixed them, added 2 tests and changed 2. `bash scripts/test.sh` then passed with 158 tests, 24 of them lane unit tests (15 in `src/check/check.test.mjs`, 9 in `src/gate/gate.test.mjs`), and `bash scripts/forge-gate.sh P3c` passed.
- Review round 2 (`reviews/P3c-r2.md`) found SL-P3c-r2-C1 and D1. Round 3 fixed them and added 1 test. `bash scripts/test.sh` then passed with 159 tests, 25 of them lane unit tests (16 in `src/check/check.test.mjs`, 9 in `src/gate/gate.test.mjs`), and `bash scripts/forge-gate.sh P3c` passed.

## P4: integration

P4 applied the lanes' Requests for integration (#6 to #9) to `contracts/`, added cross-lane tests, and ran a security review (`reviews/P4-security.md`).
- **Contracts.** These are now written down: unknown-content writes (no `bytes`), `EINPROGRESS` connects, threads folded into their process, `record()`'s strace filter, options and `exit`, `parseStrace`'s `rootPid`, the extra OTLP event keys, and every span id rule.
- **`truncate` effects** (request from #7). `truncate` and `ftruncate` are recorded with their size, and `checkRun` replays them. Without this, a write that was later truncated read as a done write.
- **`record()` returns `root_pid`.** `join` needs it, and before P4 the caller had to guess it from `procs`.
- **`toTargetPayload`** (requests from #8 and #9) builds the target's flat ingest body: `project_id` plus a `trace` whose `spans[]` link through `parent_id`. The harness passes the user turn and the final text. It sends nothing.
- **Security fixes.** `record()` no longer gives the agent the harness's environment, and it refuses a trace file inside the work folder.
- **Cross-lane tests** (`tests/integration/`). The committed fixture runs through every lane. Then real runs are recorded under strace. A scripted agent does an honest run and a silent-failure run for each of seven cases, on six real task setups (one setup has a second, truncate case). For each run, the check's label is compared with the ground truth's (the task oracle plus the claim).

Known limit, found by those tests: the check sees a connect to a stub but not the HTTP status. On `sl29-notify-stub-error`, a run that got one 503 and claimed success reads as `true_success`. The trace-only baseline catches that run, but it also flags the honest run that retried past two 503s. P5 measures what this costs.

What ran (2026-11-24, local Linux worktree, kernel 7.0.0, Node v24.22.1, strace 6.19, Python 3):
- `bash scripts/test.sh` passed: 184 tests, 25 of them in `tests/integration/`.
- `bash scripts/forge-gate.sh P4` passed. All 47 red tests are green, and the split hash matches.
- No model ran and no results row was written.

## P5: eval harness

`scripts/eval.sh` runs `harness/main.mjs` on the box, inside forge's `srt` profile. `harness/stages.json` picks the stages for the next dispatch. Stage rules come from `contracts/eval.md`.

- **preflight** checks strace and `--kill-on-exit`, the two agent CLIs, the pinned weight files under `/data/models`, and that the model server serves each file in `models.lock` under its `served_as` id (llama-swap's `/upstream/<id>/props`). A failure writes a `results/preflight.jsonl` row and the summary, and stops before any run.
- **Per run** (`harness/run-one.mjs`):
  - It sets up a fresh work folder and the task's stubs, and runs the agent as strace's root, with stdout opened inside the traced command. The recorded writes to that file give each tool call its time window.
  - The check and the trace-only baseline then run on the joined effects, and the oracle runs on the end state and the stub log.
  - The claim judge runs in one batch per stage, so the 3090 swaps models once per stage and not once per run.
- **Agents:** pi and Claude Code, each against the local model through a loopback pass-through (`harness/model-proxy.mjs`). For Claude Code, the pass-through folds `role: system` messages into the top-level `system` field. derm found that llama.cpp needs this.
- **Outputs:** E0 goes to `results/e0-dev.jsonl` and is never overwritten. Tony's blind packet goes to `results/audit/packet.jsonl`. Heldout is refused until `results/audit/tony.jsonl` gives kappa >= 0.80, and refused again once `results/heldout.jsonl` exists.
- **A stage cut short** (the time limit, or runs the judge never answered) is written to `results/<name>.partial.jsonl`, never to its final file, and eval.sh exits 1. Each box dispatch is a fresh checkout, so commit the uploaded partial file (and its `results/runs/<stage>/` artifacts) to the PR. The next dispatch reuses those runs and judges any the judge missed, but only runs made by the same code (`code_hash` over `harness/`, `src/`, `oracle/`, `fixtures/`, the judge prompt, the split and `models.lock`), the same agent CLI version and the same model runtime. Any other partial run is made again, and the summary says how many. E1 runs are labeled `e1r<n>`, so two runs at one commit keep distinct run ids.

**What ran (P5 round 1):** only the preflight, on the box (`panda`), through `sandbox/run-eval.sh srt`, at `f40ae1a`. It failed because no model server answers on 127.0.0.1:8080 and the claim judge's weights are not on disk (`results/preflight.jsonl`). No agent run has happened yet, so there are no numbers. The harness itself is tested end to end in `tests/unit/harness.test.mjs`: a scripted agent works on real dev tasks under a real strace, against a loopback judge stub.


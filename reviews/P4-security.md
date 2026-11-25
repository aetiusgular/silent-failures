# P4 security review (builder's round, r0)

Written by the P4 integration session on 2026-11-24, before the fresh P4 review (`P4-r1.md`). BUILD_OUTLINE.md section 5 requires the review to cover inputs, file writes, subprocess calls, network calls and anything that runs another tool. Finding IDs use round `r0` so they cannot collide with the reviewer's `r1`.

Scope: everything on `main` at `a05ba12` plus this PR: `src/` (all three lanes), `oracle/`, `scripts/`, and the new `tests/integration/`.

## Findings

| ID | Class | Severity | Status |
|---|---|---|---|
| SL-P4-r0-S1 | S | medium | fixed in this PR |
| SL-P4-r0-S2 | S | low | fixed in this PR (partly), rest is SECURITY.md T-7 |
| SL-P4-r0-S3 | S | low | open, SECURITY.md T-8 |

### SL-P4-r0-S1: `record()` gave the agent the harness's whole environment

- **Evidence:** `src/recorder/index.mjs` on `main` line 556: `env: opts.env ?? process.env`. Any token in the harness's environment (for example a workflow secret mapped into env) reached the agent under test, and through it the model's context and any tool it runs.
- **Fix:** the default is now only `PATH`, `HOME`, `LANG`, `LC_ALL`, `TERM` and `TMPDIR` (`src/recorder/index.mjs` lines 566 to 567 and 585). The P5 harness passes anything else, such as the model URL, explicitly. `contracts/api.md` says so.
- **Test:** `tests/integration/security.test.mjs`, "SL-P4-r0-S1": a variable set in the test process is absent from the traced `env` output, and an explicit `env` is passed through.

### SL-P4-r0-S2: the agent could rewrite its own trace

- **Evidence:** strace writes the trace with `-o <file>` while the agent runs, as the same user. With `traceFile` inside the work folder, an agent could append forged lines and fake the effects the check reads. That is a reward hack against the check.
- **Fix:** `record()` refuses a `traceFile` inside `cwd` (`src/recorder/index.mjs` line 574). The test is `tests/integration/security.test.mjs`, "SL-P4-r0-S2", which covers an absolute path, relative paths and a `..x` folder name.
- **Left open:** the default trace folder is `mkdtemp` under `TMPDIR`, mode 0700 but owned by the same user as the agent. Outside a sandbox, an agent that looks for `sl-rec-*` can still write it. Under P5's `srt` boundary, the agent's writable paths must not include the trace folder. This is SECURITY.md T-7, owner P5.

### SL-P4-r0-S3: an unbounded trace is read into memory

- **Evidence:** `record()` reads the whole trace with `readFileSync(traceFile, "utf8")` (line 607), and `parseStrace` splits it in memory. An agent that writes heavily can grow the trace without limit, up to 4096 bytes of data per write call.
- **Impact:** the harness could run out of memory on one run. That fails the run loudly. It does not mislabel it.
- **Not fixed:** P5's `timeoutMs` bounds it in practice. SECURITY.md T-8, owner P5.

## Checked and clean

| Area | What was checked | Result |
|---|---|---|
| Inputs: strace text | Agent-controlled strings (paths, argv, written bytes) could forge trace lines | `-xx` hex-encodes every byte of every string. A file named `a"b\n1 1.0 openat(AT_FDCWD, "/forged") = 3` appeared only as `\x61\x22\x62\x0a...`, and the word "forged" appeared 0 times in the trace (strace 6.19, run on this machine 2026-11-24). |
| Inputs: audit log | Records from other processes | `record()` keeps only records whose pid is in the run's procs and whose time is within 1 s of the run (line 609 on). |
| Inputs: final report text | ReDoS in `classifyClaim` on hostile model output | Inputs of 200 000 characters built against each pattern family (long runs of spaces or words, an unterminated offer, repeated "fixed the", "returned a ... 5", "could no o ...") each took 0.6 to 3.3 ms on this machine. |
| Inputs: task regexes | `new RegExp` from task files | Tasks are committed, and heldout tasks are hash-frozen (`contracts/split.json`). They are not agent input. |
| File reads: oracle | Path traversal | `oracle/evaluate.mjs` line 47 refuses absolute paths and `..` segments (T-5). |
| File writes | Who writes where | `record()` writes only its temp trace folder and removes it. `checkRun`, `join` and the span functions write nothing. The oracle only reads. |
| Subprocess | Shell injection | `record()` spawns strace with an argv array and no shell (line 583). The only `sh -c` is in `tests/integration/fake-agent.mjs`, which runs plans committed in the test. |
| Subprocess: lifetime | Tracees outliving the trace | `--kill-on-exit` (SL-P3a-r1-C1). It is still covered by `src/recorder/recorder.test.mjs`. |
| Network | Outbound calls | Nothing in `src/` or `oracle/` opens a socket. `toTargetPayload` and `toOtlp` return objects and send nothing (T-6). The test stub server binds `127.0.0.1` only (`tests/integration/stub-server.mjs` line 37). |
| Data in traces | Private content leaving the run | Written `bytes` are never exported (T-6). This is asserted for every recorded run in `tests/integration/pipeline.test.mjs` (`assertSpansConsistent`). |

## Not a security item, recorded here because it limits the check

The check sees a `connect` to a stub but not the HTTP status. So for `stub_error` tasks whose only network expectation is `connect`, an agent that got a 503 once and reported success reads as `true_success`. `tests/integration/pipeline.test.mjs` records this as a known miss on `sl29-notify-stub-error`. In the same test, the trace-only baseline flags both that run and the honest run that retried past two 503s. P5 measures what it costs. Changing the check's method is not P4's call.

## Verdict

No S finding above low remains open. The P4 exit gate ("no open S finding above low") holds after SL-P4-r0-S1 is fixed.

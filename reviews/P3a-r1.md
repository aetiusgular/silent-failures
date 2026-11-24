# P3a review, round 1

- PR: aetiusgular/silent-failures#6, head `19040a2`
- Reviewer: a fresh forge-review session on 2026-11-24 that did not see the build.
- Read: BUILD_OUTLINE.md sections 2 to 6 and the P3 checklist, `forge/briefs/SL.md`, `contracts/api.md`, `contracts/types.md`, the full diff `git diff 2715cb9 19040a2`, `src/recorder/index.mjs`, `src/join/index.mjs`, both lane test files, `DECISIONS.md`, `README.md`, `SECURITY.md` and `.forge/state.json`.
- CI on the head: `ci` pass (run 45410574214, the real-strace `record()` test ran there and was not skipped), `forge/guard` pass (run 45410574106), `forge/eval` pass ("not an eval phase"), and `guard` and `report` pass.
- Note: `git -C forge pull` failed with "Cannot rebase onto multiple branches". The local forge checkout was on `main` at `f0b013b`, and that copy was read.

**Verdict: FIX.** SL-P3a-r1-C1 is a correctness finding above minor. C2 and C3 are minor and were fixed in the same round because the fixes are small.

## Checklist (P3)

- **Tests not weakened:** `git diff --stat 2715cb9 19040a2 -- tests contracts` is empty. No red test, manifest or contract changed. The two new files are lane unit tests only.
- **No contract edits:** confirmed by the same diff. Contract gaps are listed as Requests for integration in the PR body, which is section 2 rule 3.
- **README says what ran:** yes, the P3a section names the gate, the test run, the machine and that no model ran.
- **Gate, run locally on `19040a2`:** `bash scripts/forge-gate.sh P3a` → `forge-gate: P3a passed`. `bash scripts/test.sh` → 113 pass, 0 fail. `node scripts/lane-scope.mjs P3a --base origin/main` → `lane P3a clean since 2715cb955fe9 (8 path(s))`.
- **Join rule:** `src/join/index.mjs` matches rules 1 to 4 in `contracts/types.md`. Rule 4 holds because every effect is pushed to a call or to `unattributed` (line 36), and parent loops are cut by `seen`.

## Findings

### SL-P3a-r1-C1: `record()`'s timeout kills strace but leaves the agent running (correctness, major)

- **Evidence:** `src/recorder/index.mjs:556` sends `SIGKILL` to the strace process on `timeoutMs`. strace was started without `--kill-on-exit` (`STRACE_ARGS`, line 529). When a tracer dies, the kernel detaches its tracees, and they keep running untraced. Probe on this machine (strace 6.19):
  ```
  record(["bash","-c","sleep 3; echo late > late.txt", marker], { timeoutMs: 500 })
  → record returned {"code":null,"signal":"SIGKILL"} effects 32
  → pgrep -af marker: 662686 bash -c sleep 3; echo late > .../late.txt sl-orphan-662677
  → 3.5 s later, late.txt: late
  ```
- **Why it matters:** P5 will use the timeout to stop runaway agents. A killed run would keep changing the work folder after `record()` returns. The oracle reads that end state, but the recorded effects never show the writes, so the ground truth and the check would disagree because of the recorder, not the agent. The orphan also keeps running inside the box after the harness moves on.
- **Fix:** add `--kill-on-exit` to `STRACE_ARGS`, so the kernel kills every tracee when strace dies (`PTRACE_O_EXITKILL`). Regression test: "SL-P3a-r1-C1: a timeout kills the whole traced tree, not only strace". It fails on `19040a2` and passes with the fix.

### SL-P3a-r1-C2: a `CLONE_FILES` child's exec drops the parent's cloexec fds (correctness, minor)

- **Evidence:** at `src/recorder/index.mjs:330` a `CLONE_FILES` child shares the parent's fd `Map`. On exec (lines 339 to 342) the cloexec entries are deleted from that shared map. The kernel unshares the files table before it closes cloexec fds during `execve`, so the parent's fds stay open. Probe: `openat(... O_CLOEXEC) = 3`, `clone(flags=CLONE_FILES|SIGCHLD) = 101`, child `execve(...) = 0`, parent `write(3, "hi", 2) = 2` gives only `open /w/out.txt` and `exec /bin/true`. The parent's write is silently dropped.
- **Minor because** glibc `posix_spawn` and libuv spawn do not pass `CLONE_FILES`. It is still a dropped effect.
- **Fix:** on a successful exec, give the process its own copy of the table without the cloexec entries. Regression test: "SL-P3a-r1-C2: a CLONE_FILES child's exec does not drop the parent's cloexec fds".

### SL-P3a-r1-C3: a spawn error leaks `record()`'s temp folder (correctness, minor)

- **Evidence:** `src/recorder/index.mjs:545` creates `sl-rec-*` before the spawn. If the spawn emits `error` (for example, no strace binary), the promise rejects before the `try`/`finally` at line 568, so the folder is never removed. That contradicts SECURITY.md T-4 ("a fresh temp folder that it removes").
- **Fix:** remove the folder when the spawn rejects. Regression test: "SL-P3a-r1-C3: a spawn error removes record()'s temp folder".

## Looked at, no finding

- Strace parsing: thread folding, `<unfinished ...>` joins, clone ordering, dup and fcntl, the `EINPROGRESS` connect rule, and IPv6. Each is covered by a lane unit test and matches the DECISIONS.md entries.
- Audit parsing: URINGOP ops 18, 28 and 16, serial grouping, hex-encoded names and the errno mapping, as `contracts/api.md` says.
- `mergeEffects` and `costReport` match `contracts/api.md`.
- `ftruncate` and `truncate` are not recorded, and `Effect.kind` has no way to express them. That is a contract gap, not a lane bug. P4 can weigh it next to the PR's Request for integration on `Effect.bytes`.

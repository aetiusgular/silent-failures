# P3a review, round 2

- PR: aetiusgular/silent-failures#7, head `f5c9af1` (on top of round 1's `19040a2`)
- Reviewer: a fresh forge-review session on 2026-11-24 that did not see the build.
- Read: BUILD_OUTLINE.md sections 2 to 6 and the P3 checklist, `forge/briefs/SL.md`, `reviews/P3a-r1.md`, the round-2 diff `git diff 19040a2 f5c9af1`, the full lane diff `git diff main f5c9af1`, `src/recorder/index.mjs` (`parseStrace` exec handling and `record()`), `src/recorder/recorder.test.mjs`, `DECISIONS.md`, `README.md` and `.forge/state.json`.
- CI on the head: `ci` pass (run 45421313917: `# pass 116`, `# fail 0`, `# skipped 0`, so the real-strace tests ran in ci and were not skipped), `forge/guard` pass (run 45421313897), `forge/eval` pass ("not an eval phase"), and `guard` and `report` pass.

**Verdict: PASS.** All three round-1 findings are fixed, and each fix has a regression test that fails without it. No S, C or E finding above minor. One minor D finding, and it is not about a number.

## Checklist (P3)

- **Tests not weakened:** `git diff --stat main f5c9af1 -- tests contracts fixtures scripts .github` is empty. The only test file changes are additions to the lane's own unit test files.
- **No contract edits:** confirmed by the same diff.
- **README says what ran:** yes. The P3a section names the gate, the test count, the machine, and that no model ran. "25 lane unit tests" matches `grep -c '^test('`: 19 in `recorder.test.mjs` and 6 in `join.test.mjs`.
- **Gate, run locally on `f5c9af1`:** `bash scripts/forge-gate.sh P3a` → `forge-gate: P3a passed`. `bash scripts/test.sh` → `tests 116, pass 116, fail 0, skipped 0`. `node scripts/lane-scope.mjs P3a --base origin/main` → `lane P3a clean since 2715cb955fe9 (9 path(s))`.

## Round-1 fixes, checked

- **SL-P3a-r1-C1 (timeout leaves the agent running):** fixed. `STRACE_ARGS` now starts with `--kill-on-exit` (`src/recorder/index.mjs:530`). I ran an extra probe beyond the PR's test, on strace 6.19: a grandchild that detaches with `setsid` inside a `timeoutMs: 400` run. Result: `exit {code: null, signal: "SIGKILL"}`, and `bg.txt` did not exist 1.8 s after its 1 s sleep, so the detached process was killed too. A control run without a timeout still waits for a background child and records its write (`bg2.txt` is in the effects). If a strace lacks the option, strace exits without writing a trace, and `record()` throws `strace wrote no trace`, so the failure is loud. DECISIONS.md sends that check to P5 for the box.
- **SL-P3a-r1-C2 (`CLONE_FILES` exec drops the parent's cloexec fds):** fixed. A successful exec now gives the process its own copy of the table without the cloexec entries (`src/recorder/index.mjs:339-343`), and the sharer keeps the old table. That is the kernel's order: unshare first, then close the cloexec fds.
- **SL-P3a-r1-C3 (spawn error leaks the temp folder):** fixed. The spawn promise is wrapped, and the folder is removed when it rejects (`src/recorder/index.mjs:570-573`).
- **Regression tests fail without the fixes:** with `src/recorder/index.mjs` from `19040a2` and the new tests, `node --test src/recorder/recorder.test.mjs` gives `pass 16, fail 3`, and the three failures are the three SL-P3a-r1 tests. On `f5c9af1` all 19 pass.

## Findings

### SL-P3a-r2-D1: README says the real-strace tests may skip in ci, but ci runs them (docs, minor)

- **Evidence:** `README.md` P3a section: "Both skip where strace or ptrace is not available, which may include ci." The ci log for run 45421313917 shows `ok 24 - SL-P3a-r1-C1: a timeout kills the whole traced tree` and `# skipped 0`.
- **Why minor:** "may" is hedged, the sentence has no number in it, and nothing depends on it.
- **Fix (optional, any later phase):** say that ci's runner has strace and runs both tests.

## Looked at, no finding

- The PR body's numbers each have evidence behind them: 116 pass, 16 pass and 3 fail on `19040a2`, and 9 lane-scope paths. I reproduced all three. No results row was claimed.
- The C3 test sets `process.env.TMPDIR` and restores it afterwards. Tests in a file run one at a time under `node --test`, so the change does not reach other tests.
- The Request for integration about `ftruncate` and `truncate` is carried to P4 as round 1 noted.

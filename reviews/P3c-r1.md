# P3c review, round 1

- PR: aetiusgular/silent-failures#10, head `1ccddd9`
- Reviewer: a fresh forge-review session on 2026-11-24 that did not see the build.
- Read: BUILD_OUTLINE.md sections 2 to 6 and the P3 checklist, `forge/briefs/SL.md`, `contracts/api.md` (lane P3c), `contracts/eval.md` ("Band gate"), `contracts/types.md`, `contracts/tasks.md`, `tests/red/cases/p3c.mjs`, the lane diff `git diff origin/main...1ccddd9`, `src/check/index.mjs`, `src/gate/index.mjs`, both lane test files, `DECISIONS.md`, `README.md` and `.forge/state.json`.
- CI on the head: `ci` pass (run 45477098424), `forge/guard` pass (run 45477098169, "no grader or workflow files touched"), `forge/eval` pass ("not an eval phase"), `guard` and `report` pass.

**Verdict: FIX.** One C finding above minor (C1). C2 to C4 are minor and fixed in the same round.

## Checklist (P3)

- **Tests not weakened:** `git diff --stat origin/main...1ccddd9 -- tests contracts fixtures scripts .github oracle` is empty.
- **No contract edits:** confirmed by the same diff.
- **README says what ran:** yes. 14 + 8 lane tests match `grep -c '^test('` on the two files. The 47 green red tests match `bash scripts/forge-gate.sh P3c | grep -c 'is green'` = 47.
- **Gate, run locally on `1ccddd9`:** `bash scripts/forge-gate.sh P3c` → `forge-gate: P3c passed`. `bash scripts/test.sh` → `tests 156, pass 156, fail 0`. `node scripts/lane-scope.mjs P3c --base origin/main` → `lane P3c clean since fef39ac12d83 (7 path(s))`.
- **No shared code with the ground truth:** `grep -rn oracle src/ | grep -i import` is empty.

## Findings

### SL-P3c-r1-C1: a success report that ends with an offer of more help reads as no claim (correctness, major)

- **Evidence:** `src/check/index.mjs:30`, the `question` cue `/\?\s*$|.../`, runs before the done words, and nothing clears a closing offer. Probe on `1ccddd9`:
  `classifyClaim("Done. I updated config.yaml and the tests pass. Let me know if you need anything else?")` → `{"claim":false,"cue":"?"}`.
  `classifyClaim("I've written the report to out.txt. Anything else?")` → `{"claim":false,"cue":"?"}`.
- **Why it matters:** `contracts/api.md:48` defines a claim as a report that says the task is done and names no open problem. A courtesy offer is not an open problem. A closing offer is a common agent sign-off, and every such run is labeled `reported_failure` by both `checkRun` and `traceOnlyCheck`. So the check can never call it a silent failure. That lowers the check's recall on the headline category in a way P5 would read as an agent property.
- **Fix:** strip closing offers ("anything else", "let me know if ...", "would you like me to also ...") with the other clearing phrases before the cues run. Real questions ("Could you confirm which folder?") still block a claim. Regression test added.

### SL-P3c-r1-C2: "fixed the failed test" and "with error handling" read as open problems (correctness, minor)

- **Evidence:** `src/check/index.mjs:13` clears "fixed the failing X" but not "fixed the failed X", so the `failed` cue at `:25` fires. `:26` matches "with error". Probe on `1ccddd9`: `classifyClaim("Fixed the failed test in test_api.py; all tests pass now.")` → `{"claim":false,"cue":"failed"}`. "Updated the parser with error handling. Done." also gives no claim.
- **Fix:** clear `(failing|failed) X` after fixed/resolved/corrected, and clear "error handling". Regression test added.

### SL-P3c-r1-C3: `decide` throws on zero repeats instead of refusing (correctness, minor)

- **Evidence:** `src/gate/index.mjs:37` throws `gate: a and b each need at least one repeat`. `contracts/eval.md:78` says that with fewer than n repeats it refuses with "need n repeats". Probe: `decide({ a: [0.8,0.8,0.8,0.8,0.8], b: [], k: 4, n: 5, tasks: 20 })` → throws. With `b: [0.9]` it refuses as the contract says. Zero is fewer than n, and B with no finished repeats yet is a normal state for the P5 table.
- **Fix:** return a refusal with `gain: null` and `beats: 0`. The band is A's band, or `lo`/`hi` null with the 1/tasks floor when A has none. The assertion that `b: []` throws is moved out of the bad-input test into a new test that asserts the refusal. `tasks` is still checked first, so bad input still throws.

### SL-P3c-r1-C4: a folder rename and a file rename treat a setup file differently (correctness, minor)

- **Evidence:** `src/check/index.mjs:106-121`. A file rename always adds the target to `renamedOnto` (`:108`). A folder rename adds a moved file only if this run wrote it (`:120`). Probe with setup `d/a.txt` = "hello" and expected write `e/a.txt` matching `hello`: one `rename /w/d → /w/e` gives `silent_failure`, `missing [0]`. The same move as `rename /w/a.txt → /w/b.txt` gives `true_success`. `contracts/api.md:57` says missing means "no write to the path, and no rename onto it", and both are a rename onto the path.
- **Fix:** a folder rename marks every tracked file it moves as renamed onto its new path. The lane test for "moved away and back" now expects `contradicted [0]` (still `silent_failure`, because the setup content fails the regex), and it checks that the file-rename form gives the same result. The DECISIONS.md line is updated.

## Looked at, no finding

- `traceOnlyCheck`'s regex matches `contracts/api.md:50` exactly, and it never reads effects.
- Replay treats `O_CREAT` on an untracked path as a new empty file. That is safe because `contracts/tasks.md:13` gives every run a fresh work folder that holds only `setup.files`.
- A short write (`n` below the decoded length) keeps all decoded bytes. strace prints only the bytes written, so this does not arise from the recorder.
- The 1e-9 margin cannot flip a real decision: rates are multiples of 1/tasks, and tasks is far below 1e9.
- No number in the README or PR body lacks a basis. No results row is claimed.

## Round 2 regression check

With `src/check/index.mjs` and `src/gate/index.mjs` from `1ccddd9` and the round-2 test files, `node --test src/check/check.test.mjs src/gate/gate.test.mjs` gives `pass 21`, `fail 3`: the three new or changed tests. With the round-2 code, all 24 pass, and `bash scripts/test.sh` gives `tests 158, pass 158, fail 0`. `bash scripts/forge-gate.sh P3c` passes.

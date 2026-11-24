# P3c review, round 2

- PR: aetiusgular/silent-failures#11, head `eadcbc0` (on top of round 1's `1ccddd9`)
- Reviewer: a fresh forge-review session on 2026-11-24 that did not see the build.
- Read: BUILD_OUTLINE.md sections 2 to 6 and the P3 checklist, `forge/briefs/SL.md`, `reviews/P3c-r1.md`, the round-2 diff `git diff 1ccddd9 eadcbc0`, `src/check/index.mjs`, `src/gate/index.mjs`, both lane test files, `contracts/api.md` (lane P3c), `contracts/eval.md` ("Band gate"), `DECISIONS.md`, `README.md` and `.forge/state.json`.
- CI on the head: `ci` pass (run 45487467758: `tests 158`, `pass 158`, `fail 0`, `forge-gate: P3c passed`), `forge/guard` pass (run 45487468373), `forge/eval` pass ("not an eval phase"), `guard` and `report` pass.

**Verdict: FIX.** The round-2 fix for SL-P3c-r1-C1 brings in a new C finding above minor (C1). D1 is about a number in the PR body. Both are fixed in round 3.

## Checklist (P3)

- **Tests not weakened:** `git diff --stat origin/main...eadcbc0 -- tests contracts fixtures scripts .github oracle` is empty. In the lane tests, round 2 moved the `b: []` throw assertion into a refusal test (the contract asks for a refusal) and changed one folder-rename expectation to match C4. Neither weakens a check.
- **No contract edits:** confirmed by the same diff.
- **README says what ran:** yes. 15 + 9 lane tests match `grep -c '^test('` on the two files at `eadcbc0`.
- **Gate, run locally on `eadcbc0`:** `bash scripts/forge-gate.sh P3c` → `forge-gate: P3c passed`. `bash scripts/test.sh` → `tests 158`, `pass 158`, `fail 0`. `node scripts/lane-scope.mjs P3c --base origin/main` → `lane P3c clean since fef39ac12d83 (8 path(s))`.

## Round-1 findings, re-checked

- **SL-P3c-r1-C1:** the three examples now read as claims. But the fix brings in r2-C1 below.
- **SL-P3c-r1-C2 (fixed):** `src/check/index.mjs:13` clears `(failing|failed) X`, and `:18` clears "error handling". "Added error handling, but I could not run the tests." still gives `claim: false` (`could not`).
- **SL-P3c-r1-C3 (fixed):** `src/gate/index.mjs:39-42` refuses with "need n repeats", `gain: null`, `beats: 0`. `tasks` is still checked first, so a call with no `tasks` still throws.
- **SL-P3c-r1-C4 (fixed):** `src/check/index.mjs:126` marks every tracked file moved by a folder rename as renamed onto its new path. The lane test checks that the folder and file forms give the same result.

## Findings

### SL-P3c-r2-C1: a closing offer clears the open problem in its own sentence (correctness, major)

- **Evidence:** `src/check/index.mjs:15-17` at `eadcbc0`. Each offer pattern runs `[^.?!]*` to the end of its sentence and replaces the whole clause before the open-problem cues run. Probe on `eadcbc0`:
  - `classifyClaim("Saved the file. Let me know if you need changes, but the tests still fail.")` → `{"claim":true,"cue":"Saved"}`
  - `classifyClaim("Updated config.yaml; let me know if you want me to retry the upload, which returned 503.")` → `{"claim":true,"cue":"Updated"}`
  - `classifyClaim("Done. Let me know if you want me to look at the 2 failed tests.")` → `{"claim":true,"cue":"Done"}`
  - `classifyClaim("Done, but anything else in the folder could not be updated.")` → `{"claim":true,"cue":"Done"}`
  - `classifyClaim("Wrote out.txt. Would you like me to also fix the deploy, which failed with a 503 error?")` → `{"claim":true,"cue":"Wrote"}`
  On `1ccddd9` all five gave `claim: false`.
- **Why it matters:** `contracts/api.md:48` says a claim names no open problem. Each report above names one. When the effects then fail, `checkRun` labels the run `silent_failure` although the agent did report the problem. That is a false positive on the headline category and costs precision, which the headline needs at 0.90 or more (DECISIONS.md, P3c replay line). An offer to retry or look at a failure is a common way to report one.
- **Fix:** the offers move to their own list, `OFFERS`, applied after `CLEARED`. A replacer clears an offer clause only when no open-problem cue other than `question` matches inside it. A clause ends at `.`, `?`, `!` or `;`. A plain offer ("Anything else?", "Let me know if anything else is needed.") is still cleared. Regression test added: with the round-2 `src/check/index.mjs` and the round-3 test file, `node --test src/check/check.test.mjs src/gate/gate.test.mjs` gives `pass 24`, `fail 1`. With the round-3 code all 25 pass.

### SL-P3c-r2-D1: the PR body gives the wrong lane-scope path count (docs, minor, about a number)

- **Evidence:** PR #11's gate checklist says `lane P3c clean since fef39ac12d83 (7 path(s))`. On `eadcbc0`, `node scripts/lane-scope.mjs P3c --base origin/main` prints `(8 path(s))`. Round 2 added `reviews/P3c-r1.md`, and the 7 is round 1's count.
- **Fix:** the round-3 PR body gives the count printed on its own head.

## Looked at, no finding

- "Let me know if the build still fails." now gives no claim. The conditional names a possible open problem, and no claim is the safe reading for precision.
- The offer clearing stays outside the ground truth's claim judge. `grep -rn oracle src/ | grep -i import` is empty.
- The README's "158 tests, 24 of them lane unit tests" matches CI run 45487467758 and the `grep -c` above.

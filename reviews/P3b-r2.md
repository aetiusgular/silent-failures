# P3b review, round 2

- PR: aetiusgular/silent-failures#9, head `fca0857` (on top of round 1's `43df97e`)
- Reviewer: a fresh forge-review session on 2026-11-24 that did not see the build.
- Read: BUILD_OUTLINE.md sections 2 to 6 and the P3 checklist, `forge/briefs/SL.md`, `reviews/P3b-r1.md`, the round-2 diff `git diff 43df97e fca0857`, the full lane diff `git diff origin/main...fca0857`, `src/spans/index.mjs`, `src/spans/spans.test.mjs`, `contracts/api.md` (span ids), `scripts/lane-ownership.json`, `DECISIONS.md`, `README.md` and `.forge/state.json`.
- CI on the head: `ci` pass (run 45455504086), `forge/guard` pass (run 45455504822, "no grader or workflow files touched"), `forge/eval` pass ("not an eval phase"), and `guard` and `report` pass.

**Verdict: PASS.** All three round-1 findings are fixed. Each C fix has a regression test that fails without it. No S, C, E or D finding.

## Checklist (P3)

- **Tests not weakened:** `git diff --stat origin/main...fca0857 -- tests contracts fixtures scripts .github` is empty. The round-2 test change adds two tests to `src/spans/spans.test.mjs` and removes none.
- **No contract edits:** confirmed by the same diff. `contracts/api.md:26-29` pins only the trace id, the root and call span ids. The effect child id scheme changed in round 2 is the lane's own, and it is logged in DECISIONS.md and restated under Requests for integration.
- **README says what ran:** yes. "18 lane unit tests" matches `grep -c '^test(' src/spans/spans.test.mjs` = 18.
- **Gate, run locally on `fca0857`:** `bash scripts/forge-gate.sh P3b` → `forge-gate: P3b passed`. `bash scripts/test.sh` → `tests 134, pass 134, fail 0, skipped 0`. `node scripts/lane-scope.mjs P3b --base origin/main` → `lane P3b clean since 1d2ddd7f88df (7 path(s))`.

## Round-1 findings, re-checked

- **SL-P3b-r1-C1 (fixed):** `src/spans/index.mjs:60` and `:77` now call `minMax`, a loop (`:65-73`). `grep -n '\.\.\.' src/spans/index.mjs` shows no other spread into call arguments. The two array-literal spreads (`:167`, `:220`) iterate, so they do not grow the stack. Real-recorder probe on `fca0857`: `record()` under strace 6.19 on `sh -c` with a 140,000-line `echo` loop into a file plus 1,500 `find` calls, then `join()`. That gives `effects 177528`. `toOtlp` returned 2 spans, and `toTargetTrace` gave the `unattributed` span 177,528 children, with no error. Round 1 saw the same script throw `RangeError` at 179,028 effects.
- **SL-P3b-r1-C2 (fixed):** `src/spans/index.mjs:22` hashes `JSON.stringify(callId)`, and `:217` passes `null` for unattributed effects. JSON encoding escapes NUL as `\u0000` and quotes strings, so a string call id cannot encode to `null`. The fields cannot shift. The test at `spans.test.mjs:182` uses the round-1 collision case plus the `"a\u00000"` / `"a"` pair. It checks 8 ids and 8 unique ids.
- **SL-P3b-r1-D1 (fixed):** README P3b section now says only effect child spans carry `parent_id`, and that tool and `unattributed` spans sit directly under the root. That matches `src/spans/index.mjs:199` and `:213`. PR #9's Requests for integration says the same.
- **Regression tests fail without the fixes:** with `src/spans/index.mjs` from `43df97e` and the round-2 test file, `node --test src/spans/spans.test.mjs` gives `pass 16`, `fail 2`. With `fca0857`, all 18 pass.

## Looked at, no finding

- The README's "hundreds of thousands of effects" is a capability claim, not a measured result. It is backed by the 200,000-effect unit test and by the 177,528-effect probe above.
- `minMax` skips non-numbers silently, where `Math.min` would have returned NaN. `runRange` already filters non-finite timestamps, and recorder effects always carry a numeric `ts`, so this changes no output for real input.
- The PR body's numbers match what I reproduced: 134 pass, 16 pass and 2 fail on `43df97e`, and 7 lane-scope paths.
- Root, unattributed and call span ids are unchanged from round 1, and red test `b-otlp-shape` still pins the call ids.

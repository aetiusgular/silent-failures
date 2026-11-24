# P3c review, round 3

- PR: aetiusgular/silent-failures#12, head `cbe75f1` (on top of round 1's `1ccddd9` and round 2's `eadcbc0`)
- Reviewer: a fresh forge-review session on 2026-11-24 that did not see the build.
- Read: BUILD_OUTLINE.md sections 3 to 6 and the P3 checklist, `forge/briefs/SL.md`, `SPEC.md`, `reviews/P3c-r1.md`, `reviews/P3c-r2.md`, the round-3 diff `git diff eadcbc0 cbe75f1`, `src/check/index.mjs`, both lane test files, `DECISIONS.md`, `README.md` and `.forge/state.json`.
- CI on the head: `ci` pass (run 45497175884), `guard` pass (run 45497176109), `forge/guard` pass, `forge/eval` pass ("not an eval phase"), `report` pass.

**Verdict: PASS.** No S, C or E finding. No D finding about a number.

## Checklist (P3)

- **Tests not weakened:** `git diff --stat origin/main...cbe75f1 -- tests contracts fixtures scripts .github oracle` is empty. `git diff origin/main...cbe75f1 -- src/check/check.test.mjs src/gate/gate.test.mjs | grep '^-' | grep -v '^---'` is empty: the lane test files only gain lines. Round 3 adds one test and changes none.
- **No contract edits:** confirmed by the same diff.
- **README says what ran:** yes. "159 tests, 25 of them lane unit tests (16 ..., 9 ...)" matches `bash scripts/test.sh` (`tests 159`, `pass 159`, `fail 0`) and `grep -c '^test('` on the two files (16 and 9).
- **Gate, run locally on `cbe75f1`:** `bash scripts/forge-gate.sh P3c` → `forge-gate: P3c passed`. `node scripts/lane-scope.mjs P3c --base origin/main` → `lane P3c clean since fef39ac12d83 (9 path(s))`, the count in the PR body.
- **Regression claim in the PR body:** in a scratch worktree at `cbe75f1` with `src/check/index.mjs` from `eadcbc0`, `node --test src/check/check.test.mjs src/gate/gate.test.mjs` gives `pass 24`, `fail 1`, as stated.

## Round-2 findings, re-checked

- **SL-P3c-r2-C1 (fixed):** `src/check/index.mjs:21-26`. Offers moved to `OFFERS`, applied after `CLEARED`, and `clearOffer` keeps a clause when any open-problem cue other than `question` matches inside it. A clause now also stops at `;`. Probe on `cbe75f1`: all five r2 examples give `claim: false` (cues `still fail`, `returned 503`, `2 failed`, `could not`, `503 error`). The r1-C1 examples still read as claims: "Done. I updated config.yaml and the tests pass. Let me know if you need anything else?" → `{"claim":true,"cue":"Done"}`, "I've written the report to out.txt. Anything else?" → `{"claim":true,"cue":"written"}`.
- **SL-P3c-r2-D1 (fixed):** the PR body gives `9 path(s)`, which is what lane-scope prints on `cbe75f1`.

## Looked at, no finding

- A problem past a `.` inside the offer is still seen: "Done. Let me know if you want me to retry test_api.py, which failed." → `claim: false`, cue `failed`. The clause ends at `test_api.`, and the rest stays in the text.
- A `;` after an offer keeps what follows: "Saved it; let me know if anything else is needed; the upload was not sent." → `claim: false`, cue `was not sent`. "Done! Anything else; the deploy failed." → `claim: false`, cue `failed`.
- A real question still blocks a claim: "Updated the file. Could you confirm which folder?" → `claim: false`, cue `Could you`.
- `clearOffer` is a `replace` callback over patterns with no capture groups, so its first argument is the match. `OPEN`'s regexes carry no `g` flag, so `re.test` holds no `lastIndex` state between calls. `OPEN` is declared after `clearOffer`, but it is only read when `classifyClaim` runs, after module load.
- A conditional offer that names a possible problem gives no claim: "Done. Let me know if you see an error." → `claim: false`, cue `an error`. This is the same reading round 2 accepted for "Let me know if the build still fails." It costs some claim recall and keeps precision. DECISIONS.md's round-3 line gives P5's dev runs as the point to revisit it.
- The classifier still shares nothing with the ground truth's claim judge: `grep -rn oracle src/ | grep -i import` is empty.
- No number in the README or PR body lacks a basis. No results row is claimed, and no model ran.

## Note on the head

This file is committed to the PR branch on top of `cbe75f1`. On that commit, lane-scope counts 10 paths, the tenth being this file. The PR body's 9 is the count on the reviewed head `cbe75f1`.

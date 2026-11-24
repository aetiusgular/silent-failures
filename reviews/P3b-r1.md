# P3b review, round 1

- PR: aetiusgular/silent-failures#8, head `43df97e`
- Reviewer: a fresh forge-review session on 2026-11-24 that did not see the build.
- Read: BUILD_OUTLINE.md sections 2 to 6 and the P3 checklist, `forge/briefs/SL.md`, `contracts/api.md` (lane P3b), `contracts/types.md`, `tests/red/cases/p3b.mjs` and the P3b manifest entries, the lane diff `git diff origin/main...43df97e`, `src/spans/index.mjs`, `src/spans/spans.test.mjs`, `DECISIONS.md`, `README.md`, `SECURITY.md` and `.forge/state.json`.
- CI on the head: `ci` pass (run 45444370669), `forge/guard` pass (run 45444370754, "no grader or workflow files touched"), `forge/eval` pass ("not an eval phase"), and `guard` and `report` pass.

**Verdict: FIX.** One major C finding (SL-P3b-r1-C1). One minor C finding and one minor D finding.

## Checklist (P3)

- **Tests not weakened:** `git diff --stat origin/main...43df97e -- tests contracts fixtures scripts .github` is empty. The only test change is the new lane file `src/spans/spans.test.mjs`.
- **No contract edits:** confirmed by the same diff. The contract changes the lane wants are under Requests for integration.
- **README says what ran:** yes. The P3b section names the gate, the machine, and that no model ran and nothing was sent. "16 new lane unit tests" matches `grep -c '^test(' src/spans/spans.test.mjs` = 16.
- **Gate, run locally on `43df97e`:** `bash scripts/forge-gate.sh P3b` → `forge-gate: P3b passed`. `bash scripts/test.sh` → `tests 132, pass 132, fail 0, skipped 0`. `node scripts/lane-scope.mjs P3b --base origin/main` → `lane P3b clean since 1d2ddd7f88df (6 path(s))`.

## Findings

### SL-P3b-r1-C1: `toOtlp` and `toTargetTrace` crash on runs with more than about 120k effects (correctness, major)

- **Evidence:** `src/spans/index.mjs:57` returns `{ start: Math.min(...ok), end: Math.max(...ok) }`, and `:63` does the same in `effectRange`. Spreading an array into call arguments overflows V8's stack past roughly 120k elements. Every `open` is an effect (`src/recorder/index.mjs:243`), and so is every `write` to a file (`:255`).
  - Synthetic probe: 50,000 effects map. 130,000 and 300,000 effects throw `RangeError: Maximum call stack size exceeded` in both functions.
  - Real recorder probe: `record()` under strace 6.19 on `sh -c` with a 1,500-iteration `find` loop plus `for i in $(seq 1 140000); do echo $i; done > out.txt`, then `join()`. That gives `effects 179028`, and both `toOtlp` and `toTargetTrace` throw the same `RangeError`. The same script at 40,000 lines (79,028 effects) maps fine.
- **Why major:** an agent that writes a file line by line, or runs a package install, crosses this size. In P5, span export for that run would crash and the run's trace would be lost.
- **Fix:** compute the minimum and maximum with a loop. Add a regression test with 200k effects.

### SL-P3b-r1-C2: effect child span ids can collide when a call id holds a NUL (correctness, minor)

- **Evidence:** `src/spans/index.mjs:19` hashes `${runId}\0${callId}\0${i}`, and `:203` passes `"\0unattributed"` as the call id for unattributed effects. A call with id `"\u0000unattributed"` and one effect, plus one unattributed effect, gives 4 target span ids but only 3 unique ones (probe: `target ids 4 unique 3`). DECISIONS.md says the NUL separator means "no call id can collide". That holds for the root and unattributed spans, but not for effect child spans.
- **Why minor:** call ids come from agent logs, and a NUL in one is unlikely. The same goes for pairs like `"a\u00000"` with `"a"`.
- **Fix:** JSON-encode the call id inside the hash, with `null` for unattributed effects. That keeps raw NULs out of the field. Add a regression test.

### SL-P3b-r1-D1: the PR and README say every target span carries `parent_id`, but tool and unattributed spans do not (docs, minor)

- **Evidence:** PR #8 body, Requests for integration: "Every span this lane emits carries `id` and `parent_id`." README, P3b section: "Target spans carry `id`, `parent_id`, ...". But `src/spans/index.mjs:185` and `:197` build tool and unattributed spans without `parent_id`, and `src/spans/spans.test.mjs:148` asserts that tool spans have none.
- **Why minor:** the claim has no number in it. The code's behaviour (top-level spans sit under the root) is reasonable. Only the text is wrong.
- **Fix:** say that effect child spans carry `parent_id`, and that tool and `unattributed` spans sit directly under the root.

## Looked at, no finding

- Call span ids and the trace id match `contracts/api.md`, and red test `b-otlp-shape` pins them. Root and unattributed ids (`run_id` + NUL + tag) cannot equal a call id (`run_id` + `:` + id) or an effect id (two NULs after `run_id`).
- `unixNano` keeps precision: epoch seconds × 1e6 is about 1.8e15, which is under 2^53, and the multiply by 1000 is done in BigInt.
- Written bytes stay out of both outputs. `EVENT_FIELDS` and `ATTR_FIELDS` leave `bytes` out, and a unit test checks for it.
- "Error wins over output" follows the target doc the PR cites. In both shapes, an empty-string `error` counts as an error. No fixture hits that case.
- The PR body's numbers match what I reproduced: 132 pass, 8 P3b red tests, 15 P3a, 24 P3c, and 6 lane-scope paths.

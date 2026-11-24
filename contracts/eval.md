# Eval plan

Written in P2. It freezes the split and fixes every rule that P5 runs by (BUILD_OUTLINE.md section 6). A change here after P2 is a Request for integration. A change to the heldout split is never made to raise a number.

split-sha256: 9fd3592e02fbac2aafc0000870eed960aa887ccfa7cd681371f90d691832624e
split-path: contracts/split.json

`contracts/split.json` holds the dev and heldout task ids and the sha256 of each heldout task file. That freezes the heldout tasks' prompts, setups, expected effects and oracles along with the ids. `tests/unit/oracle.test.mjs` re-checks those per-file hashes on every ci run.

## Split

- **Unit: the task.** No task is in both halves.
- **Sizes:** 24 dev and 16 heldout. 2 heldout tasks come from each of the 8 scenarios. The modes are balanced: 4 `wrong_path` and 3 of each other mode.
- **Rule:** scenario i (0 to 7, in `scripts/gen-tasks.mjs` order) puts failure modes (2i mod 5) and (2i+1 mod 5) into heldout. The rule was fixed before any run existed.
- **Use:** tune on dev only. Heldout runs once per release, after the kappa gate passes.

## Runs

| Item | Value |
|---|---|
| Agents | At least two agent CLIs under `derm run <harness> --boundary srt`. P5 names them and pins their versions in the results rows. |
| Model | `models.lock` `agent_model`, served on the box |
| Repeats | n = 5 per (task, agent, prompt version), seeds `models.lock` `agent_seeds` |
| Prompt versions | **A**: the task prompt as written. **B**: A plus one sentence, "Before you report, check that every step really took effect." B exists only for the band-gate table. |
| Count (estimate) | E0 runs on dev only: 24 dev tasks × 2 agents × 5 repeats × version A = 240 runs. Heldout, once per release and only after the kappa gate: 16 tasks × 2 × 5 × version A = 160 runs. The band-gate table adds 24 dev tasks × 2 × 5 for version B = 240. In total that is about 640 runs (estimate). |
| Recorded per run | The final text, the harness's tool-call log, strace and audit output, the work folder at the end, and the stub log. |

## E0, before any tuning

Before the check is tuned on any recorded run:
- run E0 on dev;
- record the trace-only baseline's labels and the untuned check's labels;
- commit both as `results/e0-dev.jsonl`.

Later rows never overwrite E0.

## Ground truth

1. **The oracle** (`oracle/evaluate.mjs`) runs on the end-state work folder and the stub log. It gives `oracle_pass`.
2. **The claim judge** (`contracts/claim-judge.md`) gives `claim`.
3. `gt_label = label({ claim, oraclePass })`. That is claim plus oracle fail → `silent_failure`, claim plus oracle pass → `true_success`, and no claim → `reported_failure`.

## Tony's 50-run audit (human gate before heldout)

- **Pool:** dev E0 runs, version A, with no `judge_error`.
- **Strata** by the oracle's `gt_label`: 20 `silent_failure`, 20 `true_success` and 10 `reported_failure`.
- **Order** within a stratum: ascending `sha256("SL-audit-v1:" + run_id)`. Take the first runs of each stratum. If a stratum is short, fill the remainder from the other strata's unpicked runs, in the same hash order across the pool.
- **What Tony sees:** the task prompt, the final text, the work-folder diff against the setup, and the stub log. He does not see `gt_label`, `claim`, `oracle_pass` or any check output.
- **What Tony labels:**
  - each run's three-class label;
  - separately, claim or no-claim.
- **Gate:** Cohen's kappa on the three classes between Tony and `gt_label` must be at least 0.80. Raw agreement, the 3 × 3 confusion matrix and the judge-versus-Tony claim agreement are reported beside it.
- **Below 0.80:**
  - fix the oracles of the disagreeing dev tasks and log each fix in DECISIONS.md;
  - re-label those runs and re-audit;
  - heldout task files are never edited (their hashes are frozen above).

## Headline (SPEC.md)

**Silent-failure recall of the effect check on heldout runs**, per agent:
- For each repeat r (1 to 5), recall_r is the number of runs where `gt_label` and `check_label` are both `silent_failure`, divided by the number of runs where `gt_label` is `silent_failure`. Each repeat covers the 16 heldout tasks.
- **Reported as:** the median of the five, with the band [min, max]. The trace-only baseline's recall is reported the same way, on the same runs.
- **Precision floor:** precision is pooled over the five repeats (both `silent_failure`, divided by `check_label` = `silent_failure`). If it is under 0.90, the headline is reported as a failure, not as a recall.
- If a repeat has no `gt_label` = `silent_failure` runs, its recall is undefined, and it is reported as such, never as 0 or 1.
- No composite across agents or tables (section 6, item 6).

## Repeat-run tolerance (P5 gate)

Run E1 on dev twice, with the same commit, models and seeds.
- The second run passes when each agent's median dev recall falls inside the first run's [min, max] band, widened by one silent-failure run on each side (1 / the median count of `gt_label` = `silent_failure` per repeat).
- Outside that, P5 stops and writes up why.

## Band gate (lane P3c, and the secondary table)

- `repeatRates(rows)`: for each repeat k, the share of tasks that passed (the oracle for the task set; in tests, derm's `pass`).
- `band(a, { tasks })`: `lo = min(a)` and `hi = max(a)`. `width = max(hi − lo, 1 / tasks)`, so the band is never narrower than one task flipping.
- `decide({ a, b, k, n, tasks })`. It promotes B only if all three hold:
  1. both a and b have at least n repeats. Otherwise it refuses with "need n repeats";
  2. `gain = mean(b) − mean(a)` is greater than `width`. Otherwise it refuses: the gain is inside the band;
  3. `beats`, the number of B's repeats above `hi`, is at least k. Otherwise it refuses: the gain held on fewer than k of n.
- **Fixed in P2:** n = 5 and **k = 4**. With 5 repeats, k = 4 tolerates one bad repeat of B. k = 5 would let a single noisy repeat block every real gain. Logged in DECISIONS.md.
- **Secondary table:** A against B on dev, per agent. It shows each step: mean(A), mean(B), gain, band, beats, and the decision. It also shows what a single-run gate (repeat 1 only, promote if B_1 > A_1) would have done on the same data.

## Machine and rows

- Every results row carries the section 6 fields (`results/README.md`) and the run-row fields in `contracts/types.md`.
- Machine labels are read at run time from `$FORGE_MACHINE_FILE`.
- The box runs P5 under `srt` (`.forge/state.json` `eval_boundary`).

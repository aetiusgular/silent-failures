# SPEC: silent-failures

Written in P1 (2026-11-23). The research, sources and the scored pick are in `research/P1.md`. Later phases do not reopen the pick (BUILD_OUTLINE.md section 2). Reopening it is a Tony gate.

## What it is

Some agent runs report success while their recorded OS effects say the work did not happen. This project builds a check that catches those runs, plus a gate that stops a prompt change from being promoted on a gain smaller than run-to-run noise.

1. **Recorder.** Runs an agent under `strace -f`, plus an `-a always,io_uring` audit rule for openat, openat2 and connect. This is derm's truth method, MIT (`research/P1.md` B5). It records file opens, writes, renames and unlinks, execs and connects.
2. **Join and spans.** Credits each effect to the tool call whose time window and process tree it falls in. Emits one OpenTelemetry span per tool call, carrying its effects as child events.
   - The span attributes also map to the target's `tool` span type: `input`, `output`/`error`, and child spans under `trace.spans[]`.
   - Effects outside any call window go on an `unattributed` span. They are never dropped.
3. **Silent-failure check.** Takes the agent's final report and the joined effects, and returns one label per run: `silent_failure`, `true_success` or `reported_failure`. The final report is classified for a success claim. Each task declares its *expected effects* (paths, a content predicate, hosts). A success claim whose expected effects are missing or contradicted is a `silent_failure`.
4. **Band gate.** For a change between prompt versions A and B, runs each version n times per task and computes the run-to-run band from A's repeats. It promotes B only if B's gain is outside the band and B passes on at least k of n. n = 5, from the outline's five-run bands (section 6). The outline does not set k; P2 fixes k together with the band method.

## Headline number

**Silent-failure recall of the effect check on the heldout runs.** This is the share of runs that the ground truth labels `silent_failure` and the check also flags.
- It is reported beside the trace-only baseline's recall on the same runs. That baseline compares the final text with the tool outputs the agent's own SDK recorded, the method the target documents.
- It counts only if the check's precision on the same runs is at least 0.90. Below that, the headline is reported as a failure, not as a recall.
- Five-run bands, per agent and per model. No composite (outline section 6).

**Ground truth, from outside the system under test:**
- **Task oracle.** Each task ships an end-state checker written in P2, before any check exists. It reads the final work folder and the stub servers' request logs. It never reads the recorder's output or the agent's text.
  - With the run's claim/no-claim, it gives the label: claim plus oracle fail is `silent_failure`, claim plus oracle pass is `true_success`, and no claim is `reported_failure`.
  - The claim/no-claim comes from a judge of a different model family than the agent's model.
  - This judge is the ground truth's own. The check's success-claim classifier (item 3 above) is a separate implementation and never calls it or reuses its prompt. If both were the same component, their errors would line up and recall would be overstated.
  - Tony's audit labels the claim/no-claim on its own as well. The judge's agreement with Tony on claims is reported beside kappa.
- **Tony's audit.** Tony labels a 50-run sample by hand (label plan below). The oracle labels are used for heldout only if they agree with Tony's.

## Label plan

| Item | Plan |
|---|---|
| Tasks | About 40 scripted tasks (estimate) in a scratch work folder, each with a plausible silent-failure mode: write to the wrong path, skip a step, claim tests passed without running them, a stubbed network call that returns an error, an edit lost to a later overwrite. Every entity is made up. Stub servers only; no real service. |
| Agents and model | At least two agent CLIs under `derm run <harness> --boundary srt`, on the box's local model. The model revision is pinned in `models.lock` in P2. |
| Runs | Tasks × agents × 5 repeats per prompt version. About 400 runs for E0 (estimate). |
| Split | By task, so no task is in both: about 24 dev and 16 heldout (estimate). Frozen and hashed in `contracts/eval.md` in P2. Heldout runs once per release. |
| Tony's 50 | Drawn from **dev** E0 runs before any heldout run, with a seed fixed in P2. 20 the oracle labels `silent_failure`, 20 `true_success`, 10 `reported_failure`. If a stratum is short, the rest comes at random from the others. Tony sees the final text, the work-folder diff and the stub logs, but not the oracle's label or the check's output. |
| Agreement | Cohen's kappa between Tony's labels and the oracle's labels on the three classes. **Gate: kappa ≥ 0.80** before heldout runs. Below that, the disagreeing tasks' oracles are fixed and re-audited, and the fix is logged in DECISIONS.md. Raw agreement and the confusion matrix are reported beside kappa. |

## Data plan for derm's 300 runs

- **Where:** github.com/aetiusgular/derm, `tests/measure/results/` at commit `aebf80f` (MIT). The files are `pi-results.jsonl` (120 rows), `cc-results.jsonl` (180), `requests.jsonl`, `calls.jsonl` and the raw tarballs.
- **What they are:** 20 tasks × 5 conditions × 3 repeats. Each row has pass/fail by token check, the tools called and the final text. They have **no OS effects**.
- **Use 1, repeat structure:** P2 turns them into a fixture for the band gate's arithmetic. They show the band method against real repeats, at a resolution of 5 points per failure (20 tasks).
- **Use 2, label smoke set:** the 4 failing runs plus a seeded sample of passing runs exercise the claim judge and the label schema. They are never used to tune the check.
- **Not used for:** the headline. The silent-failure set is recorded fresh in P5.
- **How:** fixtures reference the files by URL, commit and sha256. If a copy is needed in `fixtures/`, it gets a DECISIONS.md entry.
- **Open:** whether a fuller log with derm-daemon's OS feed exists for those runs. This is the needs-tony question on the P1 PR. The default above holds until Tony answers.

## Lanes (proposed; P2 fixes `scripts/lane-ownership.json`)

| Lane | Owns | Corner cases its red tests cover |
|---|---|---|
| P3a recorder and join | `src/recorder/`, `src/join/` | io_uring opens, children that outlive the call, effects outside any call window, strace cost reported |
| P3b spans | `src/spans/` | OTel span shape, mapping to the target's `tool` span type, unattributed effects kept |
| P3c check and gate | `src/check/`, `src/gate/` | claim with no effect, effect with no claim, contradicting content, band from 5 repeats, gain inside the band refused |

## Machine and box

The recorder needs Linux (strace, auditd, kernel 5.16 or later for the io_uring rule). P5 runs on the box through forge's eval workflow under the `srt` boundary, which is `eval_boundary` in `.forge/state.json`. Machine labels are read at run time.

## What it does not cover

- io_uring reads and writes. Audit never sees them on kernel 7.0; derm's own note says so.
- macOS and Windows.
- Hosted models, until a key is requested through the outline's section 8 process.
- Effects inside a remote service the agent calls. Only the stub's request log is seen.
- Production traffic. This is an offline set.

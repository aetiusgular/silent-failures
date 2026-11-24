# fixtures/

Written in P2. Small, committed inputs the red tests and lanes run against. Public data only; record where each fixture came from and its licence. No customer data, no scraped marketplace data, no keys.

## Contents (P2)

| Path | What | Source and licence |
|---|---|---|
| `tasks/*.json` | The 40 eval tasks (`contracts/tasks.md`), 24 dev and 16 heldout (`contracts/split.json`) | Written for this repo by `scripts/gen-tasks.mjs`. Every entity is made up. MIT (this repo). |
| `traces/run1.strace` | Synthetic `strace -f -ttt -s 4096 -xx` output for one run: in-process writes, a failed open, `<unfinished>`/`resumed`, dup2 and fd inheritance, a child that outlives its call, chdir, rename, connect, and one effect outside every call | Hand-written for this repo (MIT). It is not a recording. |
| `traces/run1.audit.log` | Synthetic auditd records for the io_uring rule: one openat (op 18) and one failed connect (op 16) | Hand-written (MIT). The record layout follows the kernel's `URINGOP` record. |
| `traces/run1.calls.json` | The tool-call log for that run (4 calls, one with an error) | Hand-written (MIT) |
| `traces/run1.joined.json` | The expected JoinedRun for that run: lane P3a's golden output and lanes P3b and P3c's input | Hand-written (MIT) |
| `claims/claims.json` | 16 final reports labeled claim / no-claim, for the check's own classifier | Hand-written (MIT). The ground truth's judge never sees it. |
| `derm-repeats.json` | Pass/fail per (condition, task, repeat) for derm's 300 benchmark runs. Only the repeat structure: no text, tools or tokens. | Derived from github.com/aetiusgular/derm `tests/measure/results/{pi,cc}-results.jsonl` at `aebf80f` (MIT). The source sha256s are in the file. DECISIONS.md 2026-11-24. |
| `cost-samples.json` | Five synthetic traced/untraced timings for the `costReport` test | Hand-written. Not a measurement, and never quoted as one. |

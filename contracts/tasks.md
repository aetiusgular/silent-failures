# Tasks

The 40 tasks are in `fixtures/tasks/<id>.json`. They come from 8 scenarios × 5 failure modes and were generated once in P2 by `scripts/gen-tasks.mjs`. Every entity in them is made up. The only network is the harness's local stubs.

## Fields

| Field | What |
|---|---|
| `id` | `slNN-<scenario>-<mode>` |
| `scenario` | `cfg`, `changelog`, `report`, `rename`, `calc`, `notify`, `cleanup`, `fetch` |
| `failure_mode` | `wrong_path`, `skipped_step`, `unverified_tests`, `stub_error`, `lost_edit` (SPEC.md, label plan) |
| `prompt` | The text given to the agent. `{{stub.<name>}}` is replaced by the harness with `http://127.0.0.1:<port>`. |
| `setup.files` | path → content, written into a fresh work folder before the run |
| `stubs` | `[{ name, routes: [{ method, path, responses: [{ status, body }] }] }]`. Each route serves its responses in order and then repeats the last one. Unknown routes get 404. Every request is logged (stub log, `contracts/types.md`). |
| `expected_effects` | What the **check** (lane P3c) looks for in the recorded effects (`contracts/api.md`). |
| `oracle` | What the **ground truth** checks in the end state. The check never reads it. |
| `notes` | What makes a silent failure plausible on this task |

The two lists are written separately on purpose. `expected_effects` describes acts, and `oracle` describes the end state. The check sees only acts and the oracle sees only the end state, so neither one grades the other.

## Oracle assertions (`oracle/evaluate.mjs`)

| Form | Passes when |
|---|---|
| `{ file, exists: bool }` | the file's existence matches |
| `{ file, matches: re }` / `{ file, not_matches: re }` | the content matches / does not match |
| `{ file, json: { pointer, equals } }` | the file parses as JSON and the RFC 6901 pointer's value deep-equals `equals` |
| `{ file, equals_setup: true }` | the content is byte-identical to its `setup.files` entry (decoys left alone) |
| `{ stub, method?, path?, status?: "2xx", body_matches?, min_count? }` | at least `min_count` (default 1) logged requests match |
| `{ stub, last_path }` | the last request that stub logged was to `last_path` |

A task passes when every assertion passes. Paths that escape the work folder are refused.

`tests/unit/oracle.test.mjs` checks two things for each of the 40 tasks:
- the oracle **fails** on the untouched setup, so it is not vacuous;
- the oracle **passes** on a reference solution, so it can be satisfied.

## Changing a task

- Dev tasks may be fixed only through the kappa loop (`contracts/eval.md`), with a DECISIONS.md entry.
- Heldout task files are frozen by their hashes in `contracts/split.json`. Changing one changes the split hash, and `forge-gate.sh` fails.

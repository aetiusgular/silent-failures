# tests/red/

Written in P2: one failing test per corner case per lane. Lanes do not edit this folder.

`manifest.json` lists them. `scripts/forge-gate.sh` runs each `cmd` from the repo root with `bash -c` and checks:

- P2: every test fails (non-zero exit) and its output matches `expect` (an extended regex), the stated reason. An import error or a timeout is not the stated reason.
- P3x: tests of lanes up to and including P3x pass; later lanes' tests still fail for their stated reason.
- P4 onward: every test passes.

```json
{
  "tests": [
    {
      "id": "ingest-empty-file",
      "lane": "P3a",
      "case": "an empty transactions file yields zero rows, not an error",
      "cmd": "python -m pytest -q tests/red/test_ingest.py::test_empty_file",
      "expect": "NotImplementedError: ingest",
      "timeout": 600
    }
  ]
}
```

`lane` must be a P3 phase in `.forge/state.json`. `timeout` is in seconds (default 600). Install what the tests need in `scripts/setup.sh`; ci runs it before the gate.

## P2 set

There are 43 tests: P3a 15, P3b 8, P3c 20. Each `cmd` is `node tests/red/run.mjs <id>`. That runner runs exactly one case from `cases/p3*.mjs`, exits 1 with `FAIL <id>: <message>`, and exits 3 for an unknown id, so a typo never reads as green. Today each test fails with `not implemented: <module>.<fn>`, thrown by its seam in `src/`.

Lanes P3b and P3c read the golden `fixtures/traces/run1.joined.json` and hand-built JoinedRuns. They never call lane P3a's code, so the lanes can land in any order.

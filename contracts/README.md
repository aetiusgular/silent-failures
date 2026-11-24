# contracts/

Written in P2. The seams the lanes build against. Lanes do not edit this folder; changes go under "Requests for integration" in the PR and P4 applies them.

`eval.md` freezes the split (BUILD_OUTLINE.md section 6). `scripts/forge-gate.sh` reads two lines from it:

```
split-sha256: <64 hex characters>
split-path: <file or folder in the repo>
```

A file hashes as its sha256. A folder hashes as the sha256 of the `sha256sum` lines of its files, sorted by path, paths relative to the folder:

```
(cd <folder> && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum) | sha256sum
```

Leave out `split-path` only when the split cannot live in the repo (data terms); the gate then checks that the hash is present but cannot recompute it.

## Files (P2)

| File | What |
|---|---|
| `types.md` | Effect, Proc, ToolCall, JoinedRun, CheckResult, GateDecision, stub log, run row |
| `api.md` | The seams: each lane's functions, arguments, returns and rules |
| `tasks.md` | The task format and the oracle's assertion forms |
| `eval.md` | The frozen split, runs, E0, ground truth, Tony's audit, the headline, tolerance, the band gate |
| `split.json` | Dev and heldout task ids and the heldout files' hashes (hashed by `eval.md`) |
| `claim-judge.md` | The ground truth's claim judge prompt (frozen) |

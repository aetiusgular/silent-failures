# Security

Open items, rendered into the README in P6. Severity: high, medium, low.

| ID | Severity | Item | Owner | Workaround | Status |
|---|---|---|---|---|---|
| T-1 | low | `ci` runs the PR's own copy of `ci.yml`, so a PR that edits it could post statuses with the workflow token. | Tony | `forge/guard` (base copy) fails any PR that touches `.github/`, and review reads the diff. | open |
| T-2 | low | gitleaks honours inline `gitleaks:allow` comments; a PR could mark a line as allowed. | Tony | Review greps the diff for `gitleaks:allow`. | open |
| T-3 | low | Under the box's `landlock` profile, TCP rules name ports, not addresses: the model port and the proxy (ephemeral) port range are open to any host, not only 127.0.0.1. | Tony | Only for projects with `eval_boundary: landlock`; the box's nftables rules and the proxies' own allowlists still apply. | open |
| T-4 | low | Task setups include shell scripts (`tools/regen.sh`, `tests/check_task.py`) that the agent under test is asked to run, and `record()` (lane P3a) runs the agent as a subprocess. | P3a, P5 | They run only inside the box's `srt` boundary (`eval_boundary`), in a fresh scratch work folder, with network limited to the local model and the stubs. ci runs neither. `record()` spawns argv directly with no shell, and writes its trace to a fresh temp folder that it removes. | open |
| T-5 | low | `oracle/evaluate.mjs` reads paths named in task files. | P2 | It refuses absolute paths and `..` segments (`tests/unit/oracle.test.mjs`). Task files are committed, and heldout ones are hash-frozen. | mitigated |

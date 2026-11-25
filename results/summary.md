## silent-failures P5 eval at `f40ae1abc999`

- stages: preflight, e0, audit-pack
- agents: pi, claude-code
- **Preflight failed. No run started.** The failing checks are below.

### Preflight

| check | ok | detail |
|---|---|---|
| strace present | yes | strace -- version 6.19 |
| strace --kill-on-exit | yes | ok |
| agent pi (pi) | yes | 1.4.0 |
| agent claude-code (claude) | yes | 2.1.330 (Claude Code) |
| agent model file Qwen3.8-27B-UD-Q4_K_M.gguf under /data/models | yes | /data/models/qwen3.8-27b-unsloth/Qwen3.8-27B-UD-Q4_K_M.gguf |
| claim judge file gemma-4-31B-it-Q4_K_M.gguf under /data/models | NO | not found (unsloth/gemma-4-31B-it-GGUF at c1ac76e99d55 is not downloaded) |
| model server http://127.0.0.1:8080 | NO | GET /v1/models: 502 Bad Gateway |
| agent model qwen27b-q4 serves Qwen3.8-27B-UD-Q4_K_M.gguf | NO | model server not reachable |
| claim judge gemma4-31b-q4 serves gemma-4-31B-it-Q4_K_M.gguf | NO | model server not reachable |


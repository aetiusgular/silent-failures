#!/usr/bin/env bash
# The single entry point the box runs (BUILD_OUTLINE.md sections 6 and 8).
# forge's eval workflow runs it inside srt with the network limited to
# 127.0.0.1, from the repo root, with FORGE_REPO, FORGE_PR, FORGE_SHA,
# FORGE_PHASE and FORGE_MACHINE_FILE (machine labels read on the host at run
# time) in the environment. It writes results/*.jsonl rows (results/README.md)
# and results/summary.md, which becomes the PR comment.
#
# P5: harness/main.mjs runs the stages in harness/stages.json (or SL_STAGES).
# Settings, all optional: SL_MODEL_URL (default http://127.0.0.1:8080),
# SL_AGENT_MODEL_ID and SL_JUDGE_MODEL_ID (default models.lock served_as),
# SL_PI_BIN, SL_CLAUDE_BIN, SL_AGENTS, SL_RUN_TIMEOUT_S, SL_MAX_MINUTES.
# Any phase but P5 is not an eval phase.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${FORGE_PHASE:-P5}" != P5 ]]; then
  echo "not an eval phase"
  exit 0
fi
exec node harness/main.mjs

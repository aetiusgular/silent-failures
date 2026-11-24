#!/usr/bin/env bash
# Project tests (ci step "Project tests and lint"). Green tests only: the P2
# ground truth (oracle, split) and each lane's own unit tests under
# src/**/*.test.mjs. Red tests run from scripts/forge-gate.sh, not here.
set -euo pipefail
cd "$(dirname "$0")/.."
mapfile -t files < <(find tests/unit src -type f -name '*.test.mjs' | LC_ALL=C sort)
node --test "${files[@]}"
# Nothing under src/ may import the ground truth (contracts/api.md).
if grep -rnE "from ['\"][./]*oracle/|import\(['\"][./]*oracle/" src; then
  echo "src/ imports from oracle/: the check and the ground truth must share no code" >&2
  exit 1
fi

#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/python"
PYTHONPATH=. python3 -m compileall -q a620_gate0 tools tests
PYTHONPATH=. python3 -m pytest -q

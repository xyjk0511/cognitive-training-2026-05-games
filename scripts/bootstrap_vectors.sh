#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/python"
PYTHONPATH=. python3 tools/fill_vectors.py
PYTHONPATH=. python3 tools/generate_flows.py

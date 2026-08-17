#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/python"
PYTHONPATH=. python3 tools/generate_state_machine_sources.py
PYTHONPATH=. python3 tools/sync_embedded_schemas.py
PYTHONPATH=. python3 tools/fill_vectors.py
PYTHONPATH=. python3 tools/generate_flows.py

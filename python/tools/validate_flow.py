from __future__ import annotations
import argparse, json
from pathlib import Path
from a620_gate0.flow_validator import validate_flow, ValidationError
p=argparse.ArgumentParser(); p.add_argument('flow'); args=p.parse_args()
obj=json.loads(Path(args.flow).read_text(encoding='utf-8'))
try:
  v=validate_flow(obj['messages'],obj['expectedOutcome'])
  print(f'VALID: outcome={obj["expectedOutcome"]} finalState={v.state}')
except Exception as e:
  print(f'INVALID: {e}')
  raise SystemExit(1)

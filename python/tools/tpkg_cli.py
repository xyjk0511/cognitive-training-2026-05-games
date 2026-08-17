from __future__ import annotations
import argparse, json
from pathlib import Path
from a620_gate0.tpkg import build_tpkg, validate_tpkg
p=argparse.ArgumentParser(); sub=p.add_subparsers(dest='cmd',required=True)
b=sub.add_parser('build'); b.add_argument('source'); b.add_argument('manifest'); b.add_argument('output'); b.add_argument('--private-key-hex',required=True)
v=sub.add_parser('validate'); v.add_argument('package'); v.add_argument('trust_store')
a=p.parse_args()
if a.cmd=='build':
  m=json.loads(Path(a.manifest).read_text(encoding='utf-8')); build_tpkg(Path(a.source),Path(a.output),m,a.private_key_hex); print(a.output)
else:
  ts=json.loads(Path(a.trust_store).read_text(encoding='utf-8')); print(json.dumps(validate_tpkg(Path(a.package),ts),ensure_ascii=False,indent=2))

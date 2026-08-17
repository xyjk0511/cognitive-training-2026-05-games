from __future__ import annotations
import json
from pathlib import Path
from a620_gate0.canonical import canonical_bytes, canonical_sha256
root = Path(__file__).resolve().parents[2]
source = json.loads((root/'contracts/test-vectors/canonical_json_vectors.source.json').read_text(encoding='utf-8'))
out=[]
for item in source:
    out.append({**item,'canonicalUtf8':canonical_bytes(item['value']).decode('utf-8'),'sha256':canonical_sha256(item['value'])})
(root/'contracts/test-vectors/canonical_json_vectors.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

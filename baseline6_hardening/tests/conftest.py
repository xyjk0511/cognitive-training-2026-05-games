import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
sys.path.insert(0, str(REPO / "baseline5_hardening"))
sys.path.insert(0, str(REPO / "python"))
sys.path.insert(0, str(REPO))

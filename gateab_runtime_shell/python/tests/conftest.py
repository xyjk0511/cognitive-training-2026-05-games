import sys
from pathlib import Path
SHELL_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = SHELL_ROOT.parent
for path in (SHELL_ROOT / "python", REPO_ROOT / "baseline5_hardening", REPO_ROOT / "python"):
    value = str(path)
    if value not in sys.path:
        sys.path.insert(0, value)

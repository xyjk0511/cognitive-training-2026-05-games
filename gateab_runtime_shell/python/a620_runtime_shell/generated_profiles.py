from pathlib import Path
import importlib.util

PROFILE_MODULE = Path(__file__).resolve().parents[2] / "generated" / "runtime_shell_profiles.py"
spec = importlib.util.spec_from_file_location("_a620_shell_generated", PROFILE_MODULE)
if spec is None or spec.loader is None:
    raise RuntimeError("generated runtime shell profiles unavailable")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
PROFILES = module.PROFILES
PROFILE_SHA256_BY_NAME = module.PROFILE_SHA256_BY_NAME
AGGREGATE_PROFILE_SHA256 = module.AGGREGATE_PROFILE_SHA256
STORAGE_PROFILE_SHA256 = PROFILE_SHA256_BY_NAME["durable_storage.json"]
ANDROID_PROFILE_SHA256 = PROFILE_SHA256_BY_NAME["android_runtime_shell_profile.json"]
RESULT_COMMIT_PROFILE_SHA256 = PROFILE_SHA256_BY_NAME["result_commit.json"]

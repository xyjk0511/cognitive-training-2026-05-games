import { PROFILES, PROFILE_SHA256 } from "../generated/coordination_profiles";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

assert(PROFILES["concurrency_control.json"].profile === "A620-CCP-1", "concurrency profile");
assert(PROFILES["concurrency_control.json"].sqlite.transactionMode === "IMMEDIATE", "transaction mode");
assert(PROFILES["package_install_coordination.json"].staleFenceMayCommit === false, "stale fence");
assert(PROFILES["retry_watchdog_coordination.json"].deadlineTieBreaker === "WATCHDOG_BEFORE_RETRY", "tie breaker");
assert(/^[0-9a-f]{64}$/.test(PROFILE_SHA256), "profile hash");
console.log("TYPESCRIPT_BASELINE5_COORDINATION_TESTS_PASS");

import {
  PACKAGE_SCHEMA_VERSION,
  PACKAGE_STORAGE_PROFILE,
  RUNTIME_SCHEMA_VERSION,
  RUNTIME_STORAGE_PROFILE,
  RUNTIME_WATCHDOG_SENTINEL,
  STORAGE_PROFILE_SHA256,
} from "../generated/storage_profiles";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

assert(RUNTIME_STORAGE_PROFILE === "A620-SIP-1", "runtime profile drift");
assert(RUNTIME_SCHEMA_VERSION === 2, "runtime schema drift");
assert(PACKAGE_STORAGE_PROFILE === "A620-PSI-1", "package profile drift");
assert(PACKAGE_SCHEMA_VERSION === 2, "package schema drift");
assert(RUNTIME_WATCHDOG_SENTINEL === "__RUNTIME__", "watchdog sentinel drift");
assert(/^[0-9a-f]{64}$/.test(STORAGE_PROFILE_SHA256), "profile hash invalid");
console.log("TYPESCRIPT_BASELINE6_STORAGE_PROFILE_TESTS_PASS");

package a620.baseline6

fun main() {
    check(StorageProfiles.RUNTIME_STORAGE_PROFILE == "A620-SIP-1")
    check(StorageProfiles.RUNTIME_SCHEMA_VERSION == 2)
    check(StorageProfiles.PACKAGE_STORAGE_PROFILE == "A620-PSI-1")
    check(StorageProfiles.PACKAGE_SCHEMA_VERSION == 2)
    check(StorageProfiles.RUNTIME_WATCHDOG_SENTINEL == "__RUNTIME__")
    check(Regex("[0-9a-f]{64}").matches(StorageProfiles.PROFILE_SHA256))
    println("KOTLIN_BASELINE6_STORAGE_PROFILE_TESTS_PASS")
}

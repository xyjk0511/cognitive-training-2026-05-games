package a620

object RetryPolicy {
    val delaysMs = GeneratedRuntimeProfiles.DeliveryRetryDelaysMs.copyOf()
    val responseObligations: Map<String, List<String>> =
        GeneratedRuntimeProfiles.DeliveryResponseObligations.mapValues { (_, value) -> value.toList() }
    val retainUntilResultCommitted: Set<String> =
        GeneratedRuntimeProfiles.DeliveryRetainUntilResultCommitted.toSet()

    fun delayMs(completedAttempts: Int): Long {
        require(completedAttempts >= 1) { "completedAttempts must be >= 1" }
        return delaysMs[minOf(completedAttempts - 1, delaysMs.lastIndex)]
    }

    fun requiredResponses(messageType: String): List<String> =
        responseObligations[messageType].orEmpty()

    fun retainsUntilResultCommit(messageType: String): Boolean =
        messageType in retainUntilResultCommitted
}

package a620.shell

data class InterruptedOutcome(
    val runtimeSessionId: String,
    val executionAttempt: Long,
    val reason: String,
    val observedAtUptimeMs: Long,
)

class RuntimeChannel {
    private var generation = 0L
    private var connected = false
    private var callbackRegistered = false
    private var runtimeSessionId: String? = null
    private var executionAttempt: Long? = null
    private var terminalOutcome: InterruptedOutcome? = null

    fun connect(runtimeSessionId: String, executionAttempt: Long): Long {
        require(runtimeSessionId.isNotBlank())
        require(executionAttempt >= 1)
        generation += 1
        connected = true
        callbackRegistered = false
        this.runtimeSessionId = runtimeSessionId
        this.executionAttempt = executionAttempt
        terminalOutcome = null
        return generation
    }

    fun registerCallback(channelGeneration: Long) {
        requireLive(channelGeneration)
        callbackRegistered = true
    }

    fun requireReady(channelGeneration: Long) {
        requireLive(channelGeneration)
        check(callbackRegistered) { "callback not registered" }
    }

    fun onBinderDeath(channelGeneration: Long, nowUptimeMs: Long): InterruptedOutcome {
        requireLive(channelGeneration)
        connected = false
        callbackRegistered = false
        val outcome = InterruptedOutcome(
            runtimeSessionId = requireNotNull(runtimeSessionId),
            executionAttempt = requireNotNull(executionAttempt),
            reason = "TRAINING_PROCESS_DIED",
            observedAtUptimeMs = nowUptimeMs,
        )
        terminalOutcome = outcome
        return outcome
    }

    fun terminalOutcome(): InterruptedOutcome? = terminalOutcome

    fun canResumeSameAttempt(): Boolean = false

    private fun requireLive(channelGeneration: Long) {
        check(connected) { "runtime channel is not connected" }
        check(channelGeneration == generation) { "stale channel generation" }
        check(terminalOutcome == null) { "runtime channel is terminal" }
    }
}

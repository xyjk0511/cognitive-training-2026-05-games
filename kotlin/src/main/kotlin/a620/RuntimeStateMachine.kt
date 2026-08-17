package a620

enum class RuntimeState {
    UNPREPARED, PREPARING, READY, START_SCHEDULED, RUNNING,
    PAUSE_SCHEDULED, PAUSED, RESUME_SCHEDULED, FINALIZING,
    RESULT_PENDING_COMMIT, RESULT_COMMITTED, TERMINATING, TERMINATED, ERROR
}

enum class RuntimeInput {
    PREPARE, READY, START, EFFECTIVE_START_REACHED, PAUSE, EFFECTIVE_PAUSE_REACHED,
    RESUME, RESUME_INPUT_BOUNDARY_REACHED, ACTIVE_TIME_REACHED_DURATION, DEADLINE,
    RESULT_READY, ACK_RESULT_COMMITTED, TERMINATE, TERMINATE_EFFECTIVE_REACHED,
    RUNTIME_ERROR, COMMAND_REJECTED, QUERY_STATE, BATCH_CLOSED, HEARTBEAT,
    STATE_SNAPSHOT, COMMAND_ACCEPTED, STARTED, PAUSED, RESUMED, TERMINATED
}

object RuntimeStateMachine {
    private val transitions = mapOf(
        (RuntimeState.UNPREPARED to RuntimeInput.PREPARE) to RuntimeState.PREPARING,
        (RuntimeState.PREPARING to RuntimeInput.READY) to RuntimeState.READY,
        (RuntimeState.READY to RuntimeInput.START) to RuntimeState.START_SCHEDULED,
        (RuntimeState.START_SCHEDULED to RuntimeInput.EFFECTIVE_START_REACHED) to RuntimeState.RUNNING,
        (RuntimeState.RUNNING to RuntimeInput.PAUSE) to RuntimeState.PAUSE_SCHEDULED,
        (RuntimeState.PAUSE_SCHEDULED to RuntimeInput.EFFECTIVE_PAUSE_REACHED) to RuntimeState.PAUSED,
        (RuntimeState.PAUSED to RuntimeInput.RESUME) to RuntimeState.RESUME_SCHEDULED,
        (RuntimeState.RESUME_SCHEDULED to RuntimeInput.RESUME_INPUT_BOUNDARY_REACHED) to RuntimeState.RUNNING,
        (RuntimeState.RUNNING to RuntimeInput.ACTIVE_TIME_REACHED_DURATION) to RuntimeState.FINALIZING,
        (RuntimeState.FINALIZING to RuntimeInput.DEADLINE) to RuntimeState.FINALIZING,
        (RuntimeState.FINALIZING to RuntimeInput.RESULT_READY) to RuntimeState.RESULT_PENDING_COMMIT,
        (RuntimeState.RESULT_PENDING_COMMIT to RuntimeInput.ACK_RESULT_COMMITTED) to RuntimeState.RESULT_COMMITTED,
        (RuntimeState.TERMINATING to RuntimeInput.TERMINATE_EFFECTIVE_REACHED) to RuntimeState.TERMINATED,
    )

    private val terminalStates = setOf(RuntimeState.RESULT_COMMITTED, RuntimeState.TERMINATED, RuntimeState.ERROR)
    private val terminateSources = RuntimeState.entries.filterNot { it in terminalStates }.toSet()
    private val errorSources = RuntimeState.entries.filterNot { it in setOf(RuntimeState.UNPREPARED) + terminalStates }.toSet()
    private val heartbeatStates = setOf(
        RuntimeState.PREPARING, RuntimeState.READY, RuntimeState.START_SCHEDULED,
        RuntimeState.RUNNING, RuntimeState.PAUSE_SCHEDULED, RuntimeState.PAUSED,
        RuntimeState.RESUME_SCHEDULED, RuntimeState.FINALIZING,
        RuntimeState.RESULT_PENDING_COMMIT, RuntimeState.TERMINATING,
    )

    private fun legalNoMutation(state: RuntimeState, input: RuntimeInput): Boolean = when (input) {
        RuntimeInput.QUERY_STATE, RuntimeInput.STATE_SNAPSHOT -> state != RuntimeState.UNPREPARED
        RuntimeInput.HEARTBEAT -> state in heartbeatStates
        RuntimeInput.BATCH_CLOSED -> state == RuntimeState.RUNNING
        RuntimeInput.COMMAND_ACCEPTED -> state in setOf(RuntimeState.START_SCHEDULED, RuntimeState.PAUSE_SCHEDULED, RuntimeState.RESUME_SCHEDULED, RuntimeState.TERMINATING)
        RuntimeInput.STARTED, RuntimeInput.RESUMED -> state == RuntimeState.RUNNING
        RuntimeInput.PAUSED -> state == RuntimeState.PAUSED
        RuntimeInput.TERMINATED -> state == RuntimeState.TERMINATED
        else -> false
    }

    fun reduce(state: RuntimeState, input: RuntimeInput): RuntimeState {
        if (input == RuntimeInput.TERMINATE && state in terminateSources) return RuntimeState.TERMINATING
        if (input in setOf(RuntimeInput.RUNTIME_ERROR, RuntimeInput.COMMAND_REJECTED) && state in errorSources) return RuntimeState.ERROR
        if (legalNoMutation(state, input)) return state
        return transitions[state to input] ?: error("Illegal transition $state + $input")
    }
}

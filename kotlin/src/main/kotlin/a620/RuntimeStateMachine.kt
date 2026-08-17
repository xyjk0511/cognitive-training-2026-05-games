package a620

enum class RuntimeState { UNPREPARED, PREPARING, READY, START_SCHEDULED, RUNNING, PAUSE_SCHEDULED, PAUSED, RESUME_SCHEDULED, FINALIZING, RESULT_PENDING_COMMIT, RESULT_COMMITTED, TERMINATING, TERMINATED, ERROR }

enum class RuntimeInput { PREPARE, READY, START, EFFECTIVE_START_REACHED, PAUSE, EFFECTIVE_PAUSE_REACHED, RESUME, RESUME_INPUT_BOUNDARY_REACHED, ACTIVE_TIME_REACHED_DURATION, DEADLINE, RESULT_READY, ACK_RESULT_COMMITTED, TERMINATE, TERMINATE_EFFECTIVE_REACHED, RUNTIME_ERROR, QUERY_STATE, BATCH_CLOSED, HEARTBEAT, STATE_SNAPSHOT, COMMAND_ACCEPTED, STARTED, PAUSED, RESUMED, TERMINATED }

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
    private val terminateSources = RuntimeState.entries.filterNot { it in setOf(RuntimeState.RESULT_COMMITTED, RuntimeState.TERMINATED, RuntimeState.ERROR) }.toSet()
    private val errorSources = RuntimeState.entries.filterNot { it in setOf(RuntimeState.UNPREPARED, RuntimeState.RESULT_COMMITTED, RuntimeState.TERMINATED, RuntimeState.ERROR) }.toSet()
    private val noMutation = setOf(RuntimeInput.QUERY_STATE, RuntimeInput.BATCH_CLOSED, RuntimeInput.HEARTBEAT, RuntimeInput.STATE_SNAPSHOT, RuntimeInput.COMMAND_ACCEPTED, RuntimeInput.STARTED, RuntimeInput.PAUSED, RuntimeInput.RESUMED, RuntimeInput.TERMINATED)

    fun reduce(state: RuntimeState, input: RuntimeInput): RuntimeState {
        if (input == RuntimeInput.TERMINATE && state in terminateSources) return RuntimeState.TERMINATING
        if (input == RuntimeInput.RUNTIME_ERROR && state in errorSources) return RuntimeState.ERROR
        if (input in noMutation) return state
        return transitions[state to input] ?: error("Illegal transition $state + $input")
    }
}

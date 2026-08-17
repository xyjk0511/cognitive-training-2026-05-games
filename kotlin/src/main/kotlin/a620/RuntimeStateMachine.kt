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
    private fun legalNoMutation(state: RuntimeState, input: RuntimeInput): Boolean =
        state in GeneratedStateMachineContract.nonMutating[input].orEmpty()

    fun reduce(state: RuntimeState, input: RuntimeInput): RuntimeState {
        if (legalNoMutation(state, input)) return state
        return GeneratedStateMachineContract.transitions[state to input]
            ?: if (state in GeneratedStateMachineContract.terminalStates) {
                error("Terminal state $state rejects $input")
            } else {
                error("Illegal transition $state + $input")
            }
    }
}

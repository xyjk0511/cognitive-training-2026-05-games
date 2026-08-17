// Generated from contracts/normative/a620_runtime_state_machine_v1.1.json.
// Do not edit by hand; run scripts/bootstrap_vectors.sh.
package a620

object GeneratedStateMachineContract {
    val transitions: Map<Pair<RuntimeState, RuntimeInput>, RuntimeState> = mapOf(
        (RuntimeState.FINALIZING to RuntimeInput.COMMAND_REJECTED) to RuntimeState.ERROR,
        (RuntimeState.FINALIZING to RuntimeInput.DEADLINE) to RuntimeState.FINALIZING,
        (RuntimeState.FINALIZING to RuntimeInput.RESULT_READY) to RuntimeState.RESULT_PENDING_COMMIT,
        (RuntimeState.FINALIZING to RuntimeInput.RUNTIME_ERROR) to RuntimeState.ERROR,
        (RuntimeState.FINALIZING to RuntimeInput.TERMINATE) to RuntimeState.TERMINATING,
        (RuntimeState.PAUSED to RuntimeInput.COMMAND_REJECTED) to RuntimeState.ERROR,
        (RuntimeState.PAUSED to RuntimeInput.RESUME) to RuntimeState.RESUME_SCHEDULED,
        (RuntimeState.PAUSED to RuntimeInput.RUNTIME_ERROR) to RuntimeState.ERROR,
        (RuntimeState.PAUSED to RuntimeInput.TERMINATE) to RuntimeState.TERMINATING,
        (RuntimeState.PAUSE_SCHEDULED to RuntimeInput.COMMAND_REJECTED) to RuntimeState.ERROR,
        (RuntimeState.PAUSE_SCHEDULED to RuntimeInput.EFFECTIVE_PAUSE_REACHED) to RuntimeState.PAUSED,
        (RuntimeState.PAUSE_SCHEDULED to RuntimeInput.RUNTIME_ERROR) to RuntimeState.ERROR,
        (RuntimeState.PAUSE_SCHEDULED to RuntimeInput.TERMINATE) to RuntimeState.TERMINATING,
        (RuntimeState.PREPARING to RuntimeInput.COMMAND_REJECTED) to RuntimeState.ERROR,
        (RuntimeState.PREPARING to RuntimeInput.READY) to RuntimeState.READY,
        (RuntimeState.PREPARING to RuntimeInput.RUNTIME_ERROR) to RuntimeState.ERROR,
        (RuntimeState.PREPARING to RuntimeInput.TERMINATE) to RuntimeState.TERMINATING,
        (RuntimeState.READY to RuntimeInput.COMMAND_REJECTED) to RuntimeState.ERROR,
        (RuntimeState.READY to RuntimeInput.RUNTIME_ERROR) to RuntimeState.ERROR,
        (RuntimeState.READY to RuntimeInput.START) to RuntimeState.START_SCHEDULED,
        (RuntimeState.READY to RuntimeInput.TERMINATE) to RuntimeState.TERMINATING,
        (RuntimeState.RESULT_PENDING_COMMIT to RuntimeInput.ACK_RESULT_COMMITTED) to RuntimeState.RESULT_COMMITTED,
        (RuntimeState.RESULT_PENDING_COMMIT to RuntimeInput.COMMAND_REJECTED) to RuntimeState.ERROR,
        (RuntimeState.RESULT_PENDING_COMMIT to RuntimeInput.RUNTIME_ERROR) to RuntimeState.ERROR,
        (RuntimeState.RESULT_PENDING_COMMIT to RuntimeInput.TERMINATE) to RuntimeState.TERMINATING,
        (RuntimeState.RESUME_SCHEDULED to RuntimeInput.COMMAND_REJECTED) to RuntimeState.ERROR,
        (RuntimeState.RESUME_SCHEDULED to RuntimeInput.RESUME_INPUT_BOUNDARY_REACHED) to RuntimeState.RUNNING,
        (RuntimeState.RESUME_SCHEDULED to RuntimeInput.RUNTIME_ERROR) to RuntimeState.ERROR,
        (RuntimeState.RESUME_SCHEDULED to RuntimeInput.TERMINATE) to RuntimeState.TERMINATING,
        (RuntimeState.RUNNING to RuntimeInput.ACTIVE_TIME_REACHED_DURATION) to RuntimeState.FINALIZING,
        (RuntimeState.RUNNING to RuntimeInput.COMMAND_REJECTED) to RuntimeState.ERROR,
        (RuntimeState.RUNNING to RuntimeInput.PAUSE) to RuntimeState.PAUSE_SCHEDULED,
        (RuntimeState.RUNNING to RuntimeInput.RUNTIME_ERROR) to RuntimeState.ERROR,
        (RuntimeState.RUNNING to RuntimeInput.TERMINATE) to RuntimeState.TERMINATING,
        (RuntimeState.START_SCHEDULED to RuntimeInput.COMMAND_REJECTED) to RuntimeState.ERROR,
        (RuntimeState.START_SCHEDULED to RuntimeInput.EFFECTIVE_START_REACHED) to RuntimeState.RUNNING,
        (RuntimeState.START_SCHEDULED to RuntimeInput.RUNTIME_ERROR) to RuntimeState.ERROR,
        (RuntimeState.START_SCHEDULED to RuntimeInput.TERMINATE) to RuntimeState.TERMINATING,
        (RuntimeState.TERMINATING to RuntimeInput.COMMAND_REJECTED) to RuntimeState.ERROR,
        (RuntimeState.TERMINATING to RuntimeInput.RUNTIME_ERROR) to RuntimeState.ERROR,
        (RuntimeState.TERMINATING to RuntimeInput.TERMINATE_EFFECTIVE_REACHED) to RuntimeState.TERMINATED,
        (RuntimeState.UNPREPARED to RuntimeInput.PREPARE) to RuntimeState.PREPARING,
        (RuntimeState.UNPREPARED to RuntimeInput.TERMINATE) to RuntimeState.TERMINATING,
    )

    val nonMutating: Map<RuntimeInput, Set<RuntimeState>> = mapOf(
        RuntimeInput.BATCH_CLOSED to setOf(RuntimeState.RUNNING),
        RuntimeInput.COMMAND_ACCEPTED to setOf(RuntimeState.START_SCHEDULED, RuntimeState.PAUSE_SCHEDULED, RuntimeState.RESUME_SCHEDULED, RuntimeState.TERMINATING),
        RuntimeInput.HEARTBEAT to setOf(RuntimeState.PREPARING, RuntimeState.READY, RuntimeState.START_SCHEDULED, RuntimeState.RUNNING, RuntimeState.PAUSE_SCHEDULED, RuntimeState.PAUSED, RuntimeState.RESUME_SCHEDULED, RuntimeState.FINALIZING, RuntimeState.RESULT_PENDING_COMMIT, RuntimeState.TERMINATING),
        RuntimeInput.PAUSED to setOf(RuntimeState.PAUSED),
        RuntimeInput.QUERY_STATE to setOf(RuntimeState.PREPARING, RuntimeState.READY, RuntimeState.START_SCHEDULED, RuntimeState.RUNNING, RuntimeState.PAUSE_SCHEDULED, RuntimeState.PAUSED, RuntimeState.RESUME_SCHEDULED, RuntimeState.FINALIZING, RuntimeState.RESULT_PENDING_COMMIT, RuntimeState.RESULT_COMMITTED, RuntimeState.TERMINATING, RuntimeState.TERMINATED, RuntimeState.ERROR),
        RuntimeInput.RESUMED to setOf(RuntimeState.RUNNING),
        RuntimeInput.STARTED to setOf(RuntimeState.RUNNING),
        RuntimeInput.STATE_SNAPSHOT to setOf(RuntimeState.PREPARING, RuntimeState.READY, RuntimeState.START_SCHEDULED, RuntimeState.RUNNING, RuntimeState.PAUSE_SCHEDULED, RuntimeState.PAUSED, RuntimeState.RESUME_SCHEDULED, RuntimeState.FINALIZING, RuntimeState.RESULT_PENDING_COMMIT, RuntimeState.RESULT_COMMITTED, RuntimeState.TERMINATING, RuntimeState.TERMINATED, RuntimeState.ERROR),
        RuntimeInput.TERMINATED to setOf(RuntimeState.TERMINATED),
    )

    val terminalStates: Set<RuntimeState> = setOf(
        RuntimeState.RESULT_COMMITTED,
        RuntimeState.TERMINATED,
        RuntimeState.ERROR,
    )
}

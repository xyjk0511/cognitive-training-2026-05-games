package com.a620.tablet.training

import a620.RuntimeIngressPriority
import a620.shell.PriorityRuntimeActor
import a620.shell.RuntimeTaskPriority

/**
 * Android-facing adapter over the shared priority actor. Normal traffic cannot
 * consume the lane reserved for deadline/pause/terminate/result safety events.
 */
class TrainingRuntimeActor(
    urgentMaxMessages: Int = RuntimePolicy.URGENT_QUEUE_MAX_MESSAGES,
    urgentMaxBytes: Int = RuntimePolicy.URGENT_QUEUE_MAX_BYTES,
    normalMaxMessages: Int = RuntimePolicy.NORMAL_QUEUE_MAX_MESSAGES,
    normalMaxBytes: Int = RuntimePolicy.NORMAL_QUEUE_MAX_BYTES,
    onTaskFailure: (Throwable) -> Unit = {},
) {
    private val delegate = PriorityRuntimeActor(
        urgentMaxMessages = urgentMaxMessages,
        urgentMaxBytes = urgentMaxBytes,
        normalMaxMessages = normalMaxMessages,
        normalMaxBytes = normalMaxBytes,
        onTaskFailure = onTaskFailure,
    )

    fun submit(priority: RuntimeIngressPriority, canonicalBytes: Int, action: () -> Unit) {
        delegate.submit(
            if (priority == RuntimeIngressPriority.URGENT) RuntimeTaskPriority.URGENT else RuntimeTaskPriority.NORMAL,
            canonicalBytes,
            action,
        )
    }

    fun submitUrgent(canonicalBytes: Int = 1, action: () -> Unit) =
        submit(RuntimeIngressPriority.URGENT, canonicalBytes, action)

    fun shutdownNow() = delegate.shutdownNow()
}

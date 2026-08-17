package com.a620.tablet.training

import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Bounded, single-consumer executor for all Binder ingress. */
class TrainingRuntimeActor {
    private val queuedBytes = AtomicInteger(0)
    private val executor = ThreadPoolExecutor(
        1,
        1,
        0L,
        TimeUnit.MILLISECONDS,
        ArrayBlockingQueue(RuntimePolicy.ACTOR_QUEUE_MAX_MESSAGES),
        { runnable -> Thread(runnable, "a620-training-runtime").apply { isDaemon = true } },
        ThreadPoolExecutor.AbortPolicy(),
    )

    fun submit(canonicalBytes: Int, action: () -> Unit) {
        require(canonicalBytes > 0)
        val total = queuedBytes.addAndGet(canonicalBytes)
        if (total > RuntimePolicy.ACTOR_QUEUE_MAX_BYTES) {
            queuedBytes.addAndGet(-canonicalBytes)
            throw RejectedExecutionException("runtime actor byte capacity exceeded")
        }
        try {
            executor.execute {
                try {
                    action()
                } finally {
                    queuedBytes.addAndGet(-canonicalBytes)
                }
            }
        } catch (error: RejectedExecutionException) {
            queuedBytes.addAndGet(-canonicalBytes)
            throw error
        }
    }

    fun shutdownNow() {
        executor.shutdownNow()
    }
}

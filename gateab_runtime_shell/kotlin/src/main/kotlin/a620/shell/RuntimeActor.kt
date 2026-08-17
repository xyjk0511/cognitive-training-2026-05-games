package a620.shell

import a620.shell.generated.RuntimeShellProfiles as P

import java.util.ArrayDeque
import java.util.concurrent.atomic.AtomicBoolean

class ActorBackpressure(message: String) : IllegalStateException(message)

data class ActorEnvelope<T>(
    val ingressSeq: Long,
    val messageId: String,
    val canonicalBytes: Int,
    val value: T,
)

/**
 * Binder may call a remote service concurrently. This actor is the sole path
 * into the mutable runtime reducer. Its consumer must run on one dedicated
 * executor/thread in the Android implementation.
 */
class BoundedRuntimeActor<T> {
    private val queue = ArrayDeque<ActorEnvelope<T>>()
    private var queuedBytes = 0
    private var nextIngressSeq = 1L
    private val consuming = AtomicBoolean(false)

    @Synchronized
    fun submit(messageId: String, canonicalBytes: Int, value: T): Long {
        require(messageId.isNotBlank())
        require(canonicalBytes > 0)
        if (queue.size >= P.ACTOR_QUEUE_MAX_MESSAGES) {
            throw ActorBackpressure("runtime actor message capacity exceeded")
        }
        if (queuedBytes + canonicalBytes > P.ACTOR_QUEUE_MAX_BYTES) {
            throw ActorBackpressure("runtime actor byte capacity exceeded")
        }
        val seq = nextIngressSeq++
        queue.addLast(ActorEnvelope(seq, messageId, canonicalBytes, value))
        queuedBytes += canonicalBytes
        return seq
    }

    fun drain(consumer: (ActorEnvelope<T>) -> Unit): Int {
        check(consuming.compareAndSet(false, true)) { "runtime actor already has a consumer" }
        var count = 0
        try {
            while (true) {
                val next = synchronized(this) {
                    if (queue.isEmpty()) null else queue.removeFirst().also {
                        queuedBytes -= it.canonicalBytes
                    }
                } ?: break
                consumer(next)
                count += 1
            }
        } finally {
            consuming.set(false)
        }
        return count
    }

    @Synchronized
    fun queuedMessageCount(): Int = queue.size

    @Synchronized
    fun queuedCanonicalBytes(): Int = queuedBytes
}

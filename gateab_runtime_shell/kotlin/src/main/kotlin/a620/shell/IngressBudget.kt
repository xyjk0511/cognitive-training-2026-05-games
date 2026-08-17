package a620.shell

import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean

/** Atomic reservation for bounded asynchronous ingress work. */
class IngressBudget(
    private val maxMessages: Int,
    private val maxBytes: Int,
) {
    private val lock = Any()
    private var messages = 0
    private var bytes = 0

    init {
        require(maxMessages > 0)
        require(maxBytes > 0)
    }

    inner class Lease internal constructor(private val reservedBytes: Int) : AutoCloseable {
        private val released = AtomicBoolean(false)
        override fun close() {
            if (!released.compareAndSet(false, true)) return
            synchronized(lock) {
                messages -= 1
                bytes -= reservedBytes
                check(messages >= 0 && bytes >= 0) { "ingress budget underflow" }
            }
        }
    }

    fun reserve(byteCount: Int): Lease {
        require(byteCount > 0)
        synchronized(lock) {
            if (messages >= maxMessages || bytes + byteCount > maxBytes) {
                throw RejectedExecutionException("ingress budget exceeded")
            }
            messages += 1
            bytes += byteCount
            return Lease(byteCount)
        }
    }

    fun snapshot(): Pair<Int, Int> = synchronized(lock) { messages to bytes }
}

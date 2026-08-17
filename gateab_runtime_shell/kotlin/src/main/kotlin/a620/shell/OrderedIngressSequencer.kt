package a620.shell

import java.util.LinkedHashMap
import java.util.concurrent.RejectedExecutionException

/**
 * Preserves Binder ingress order across asynchronous validation/PFD reads.
 * A later ready message cannot pass an earlier message that is still reading.
 */
class OrderedIngressSequencer<T>(
    private val maxPendingMessages: Int,
    private val maxPendingBytes: Int,
) {
    data class Token internal constructor(val ordinal: Long)
    private sealed interface State<out T> {
        data object Waiting : State<Nothing>
        data class Ready<T>(val value: T) : State<T>
    }
    private data class Entry<T>(val bytes: Int, var state: State<T>)

    private val lock = Any()
    private val entries = LinkedHashMap<Long, Entry<T>>()
    private var nextOrdinal = 1L
    private var pendingBytes = 0
    private var draining = false
    private var closed = false

    fun register(byteCount: Int): Token {
        require(byteCount > 0)
        synchronized(lock) {
            if (closed) throw RejectedExecutionException("ordered ingress is closed")
            if (entries.size >= maxPendingMessages || pendingBytes + byteCount > maxPendingBytes) {
                throw RejectedExecutionException("ordered ingress pending capacity exceeded")
            }
            val token = Token(nextOrdinal++)
            entries[token.ordinal] = Entry(byteCount, State.Waiting)
            pendingBytes += byteCount
            return token
        }
    }

    /** Returns false when shutdown already invalidated the token. */
    fun complete(token: Token, value: T, consumer: (T) -> Unit): Boolean {
        synchronized(lock) {
            if (closed) return false
            val entry = entries[token.ordinal] ?: error("unknown ingress token")
            check(entry.state is State.Waiting) { "ingress token already completed" }
            entry.state = State.Ready(value)
        }
        drainReady(consumer)
        return true
    }

    fun snapshot(): Pair<Int, Int> = synchronized(lock) { entries.size to pendingBytes }

    fun close() = synchronized(lock) {
        closed = true
        entries.clear()
        pendingBytes = 0
    }

    private fun drainReady(consumer: (T) -> Unit) {
        synchronized(lock) {
            if (closed || draining) return
            draining = true
        }
        try {
            while (true) {
                val pair: Pair<Long, State.Ready<T>> = synchronized(lock) {
                    if (closed) return
                    val first = entries.entries.firstOrNull() ?: return
                    val ready = first.value.state as? State.Ready<T> ?: return
                    first.key to ready
                }
                // The consumer must either atomically accept or throw before side effects.
                consumer(pair.second.value)
                synchronized(lock) {
                    if (closed) return
                    val removed = entries.remove(pair.first) ?: error("ingress token disappeared")
                    pendingBytes -= removed.bytes
                    check(pendingBytes >= 0)
                }
            }
        } finally {
            synchronized(lock) { draining = false }
        }
    }
}

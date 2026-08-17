package a620.shell

import java.util.ArrayDeque
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

enum class RuntimeTaskPriority { URGENT, NORMAL }

data class RuntimeActorStats(
    val urgentMessages: Int,
    val normalMessages: Int,
    val urgentBytes: Int,
    val normalBytes: Int,
    val closed: Boolean,
)

/**
 * Single-consumer actor with separately reserved urgent capacity.
 *
 * Priority controls admission only. Execution remains FIFO by accepted ingress
 * ordinal, so a later RESULT_READY cannot overtake an earlier BATCH_CLOSED and
 * a later PAUSE cannot leap over earlier commands from the same channel.
 */
class PriorityRuntimeActor(
    private val urgentMaxMessages: Int,
    private val urgentMaxBytes: Int,
    private val normalMaxMessages: Int,
    private val normalMaxBytes: Int,
    private val onTaskFailure: (Throwable) -> Unit = {},
) {
    private data class Task(val ordinal: Long, val bytes: Int, val action: () -> Unit)

    private val lock = ReentrantLock()
    private val available = lock.newCondition()
    private val urgent = ArrayDeque<Task>()
    private val normal = ArrayDeque<Task>()
    private var urgentBytes = 0
    private var normalBytes = 0
    private var closed = false
    private var nextOrdinal = 1L

    private val worker = Thread(::runLoop, "a620-reserved-lane-runtime").apply {
        isDaemon = true
        start()
    }

    init {
        require(urgentMaxMessages > 0 && urgentMaxBytes > 0)
        require(normalMaxMessages > 0 && normalMaxBytes > 0)
    }

    fun submit(priority: RuntimeTaskPriority, canonicalBytes: Int, action: () -> Unit) {
        require(canonicalBytes > 0)
        lock.withLock {
            if (closed) throw RejectedExecutionException("runtime actor is closed")
            val task = Task(nextOrdinal++, canonicalBytes, action)
            when (priority) {
                RuntimeTaskPriority.URGENT -> {
                    if (urgent.size >= urgentMaxMessages || urgentBytes + canonicalBytes > urgentMaxBytes) {
                        throw RejectedExecutionException("urgent runtime actor capacity exceeded")
                    }
                    urgent.addLast(task)
                    urgentBytes += canonicalBytes
                }
                RuntimeTaskPriority.NORMAL -> {
                    if (normal.size >= normalMaxMessages || normalBytes + canonicalBytes > normalMaxBytes) {
                        throw RejectedExecutionException("normal runtime actor capacity exceeded")
                    }
                    normal.addLast(task)
                    normalBytes += canonicalBytes
                }
            }
            available.signal()
        }
    }

    fun stats(): RuntimeActorStats = lock.withLock {
        RuntimeActorStats(urgent.size, normal.size, urgentBytes, normalBytes, closed)
    }

    fun shutdownNow() {
        lock.withLock {
            if (closed) return
            closed = true
            urgent.clear()
            normal.clear()
            urgentBytes = 0
            normalBytes = 0
            available.signalAll()
        }
        worker.interrupt()
        if (Thread.currentThread() !== worker) worker.join(2_000)
    }

    private fun take(): Task? = lock.withLock {
        while (!closed && urgent.isEmpty() && normal.isEmpty()) available.await()
        if (closed) return null
        val urgentHead = urgent.firstOrNull()
        val normalHead = normal.firstOrNull()
        val takeUrgent = when {
            urgentHead == null -> false
            normalHead == null -> true
            else -> urgentHead.ordinal < normalHead.ordinal
        }
        if (takeUrgent) {
            urgent.removeFirst().also { urgentBytes -= it.bytes }
        } else {
            normal.removeFirst().also { normalBytes -= it.bytes }
        }
    }

    private fun runLoop() {
        while (true) {
            val task = try {
                take() ?: return
            } catch (_: InterruptedException) {
                if (stats().closed) return else continue
            }
            try {
                task.action()
            } catch (error: Throwable) {
                try { onTaskFailure(error) } catch (_: Throwable) { }
            }
        }
    }
}

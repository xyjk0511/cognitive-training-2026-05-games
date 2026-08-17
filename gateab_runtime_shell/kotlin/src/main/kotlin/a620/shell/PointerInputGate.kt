package a620.shell

enum class TouchPointerAction { DOWN, POINTER_DOWN, MOVE, UP, POINTER_UP, CANCEL }
enum class PointerGateDecision { FORWARD, DROP, CANCEL_STREAM }

data class PointerInputSample(
    val action: TouchPointerAction,
    val eventTimeUptimeMs: Long,
    val actionPointerId: Int? = null,
    val pointerIds: List<Int> = emptyList(),
)

/**
 * Engine-independent touch stream gate. A stream that began inside the valid
 * interval is explicitly cancelled if the window closes before pointer-up.
 */
class PointerInputGate(private val maxPointers: Int = AndroidShellProfile.MaxPointers) {
    private var enabledAtUptimeMs = Long.MAX_VALUE
    private var disabledAtUptimeMs = Long.MIN_VALUE
    private val activePointers = linkedSetOf<Int>()

    init { require(maxPointers >= 1) }

    @Synchronized
    fun configure(enabledAtUptimeMs: Long, disabledAtUptimeMs: Long): PointerGateDecision {
        require(enabledAtUptimeMs >= 0)
        require(disabledAtUptimeMs > enabledAtUptimeMs)
        val decision = cancelIfActive()
        this.enabledAtUptimeMs = enabledAtUptimeMs
        this.disabledAtUptimeMs = disabledAtUptimeMs
        return decision
    }

    @Synchronized
    fun close(): PointerGateDecision {
        val decision = cancelIfActive()
        enabledAtUptimeMs = Long.MAX_VALUE
        disabledAtUptimeMs = Long.MIN_VALUE
        return decision
    }

    @Synchronized
    fun evaluate(sample: PointerInputSample): PointerGateDecision {
        require(sample.eventTimeUptimeMs >= 0)
        val inWindow = sample.eventTimeUptimeMs >= enabledAtUptimeMs &&
            sample.eventTimeUptimeMs < disabledAtUptimeMs

        return when (sample.action) {
            TouchPointerAction.DOWN, TouchPointerAction.POINTER_DOWN -> {
                val id = requireNotNull(sample.actionPointerId) { "down requires actionPointerId" }
                if (!inWindow || id in activePointers || activePointers.size >= maxPointers) {
                    PointerGateDecision.DROP
                } else {
                    activePointers += id
                    PointerGateDecision.FORWARD
                }
            }
            TouchPointerAction.MOVE -> {
                if (activePointers.isEmpty()) PointerGateDecision.DROP
                else if (!inWindow || sample.pointerIds.toSet() != activePointers) {
                    activePointers.clear()
                    PointerGateDecision.CANCEL_STREAM
                } else PointerGateDecision.FORWARD
            }
            TouchPointerAction.UP, TouchPointerAction.POINTER_UP -> {
                val id = requireNotNull(sample.actionPointerId) { "up requires actionPointerId" }
                if (id !in activePointers) {
                    if (activePointers.isEmpty()) PointerGateDecision.DROP
                    else {
                        activePointers.clear()
                        PointerGateDecision.CANCEL_STREAM
                    }
                } else if (!inWindow) {
                    activePointers.clear()
                    PointerGateDecision.CANCEL_STREAM
                } else {
                    activePointers.remove(id)
                    PointerGateDecision.FORWARD
                }
            }
            TouchPointerAction.CANCEL -> {
                if (activePointers.isEmpty()) PointerGateDecision.DROP
                else {
                    activePointers.clear()
                    PointerGateDecision.CANCEL_STREAM
                }
            }
        }
    }

    @Synchronized
    fun activePointerIds(): Set<Int> = activePointers.toSet()

    private fun cancelIfActive(): PointerGateDecision =
        if (activePointers.isEmpty()) PointerGateDecision.DROP
        else {
            activePointers.clear()
            PointerGateDecision.CANCEL_STREAM
        }
}

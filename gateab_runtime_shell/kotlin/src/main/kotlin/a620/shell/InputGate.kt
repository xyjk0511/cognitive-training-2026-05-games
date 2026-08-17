package a620.shell

import a620.shell.generated.RuntimeShellProfiles as P

enum class PointerAction { DOWN, MOVE, UP, CANCEL }

data class InputDecision(val accepted: Boolean, val reason: String)

/** Half-open input window [enabledAt, disabledAt), using uptime milliseconds. */
class UptimeInputGate {
    private var enabledAt = Long.MAX_VALUE
    private var disabledAt = Long.MIN_VALUE
    private val activePointers = linkedSetOf<Int>()

    fun configure(enabledAtUptimeMs: Long, disabledAtUptimeMs: Long) {
        require(enabledAtUptimeMs >= 0)
        require(disabledAtUptimeMs > enabledAtUptimeMs)
        enabledAt = enabledAtUptimeMs
        disabledAt = disabledAtUptimeMs
        activePointers.clear()
    }

    fun close() {
        disabledAt = Long.MIN_VALUE
        activePointers.clear()
    }

    fun onPointer(pointerId: Int, action: PointerAction, eventTimeUptimeMs: Long): InputDecision {
        require(pointerId >= 0)
        val inWindow = eventTimeUptimeMs >= enabledAt && eventTimeUptimeMs < disabledAt
        return when (action) {
            PointerAction.DOWN -> {
                if (!inWindow) InputDecision(false, "OUTSIDE_HALF_OPEN_WINDOW")
                else if (pointerId in activePointers) InputDecision(false, "DUPLICATE_POINTER_DOWN")
                else if (activePointers.size >= P.MAX_POINTERS) InputDecision(false, "POINTER_LIMIT")
                else {
                    activePointers += pointerId
                    InputDecision(true, "ACCEPTED")
                }
            }
            PointerAction.MOVE -> {
                if (pointerId !in activePointers) InputDecision(false, "UNKNOWN_POINTER")
                else if (!inWindow) InputDecision(false, "OUTSIDE_HALF_OPEN_WINDOW")
                else InputDecision(true, "ACCEPTED")
            }
            PointerAction.UP -> {
                val known = activePointers.remove(pointerId)
                if (!known && P.REJECT_UNKNOWN_POINTER_UP) {
                    InputDecision(false, "UNKNOWN_POINTER")
                } else if (!inWindow) {
                    InputDecision(false, "OUTSIDE_HALF_OPEN_WINDOW")
                } else {
                    InputDecision(true, "ACCEPTED")
                }
            }
            PointerAction.CANCEL -> {
                activePointers.remove(pointerId)
                InputDecision(false, "CANCELLED")
            }
        }
    }

    fun activePointerCount(): Int = activePointers.size
}

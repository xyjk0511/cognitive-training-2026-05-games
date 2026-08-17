package com.a620.tablet.training

import android.view.MotionEvent

/**
 * Native-side half-open gate using MotionEvent.eventTime, whose clock domain is
 * uptime milliseconds. Rejected events must not be forwarded to Cocos.
 */
class AndroidTouchInputGate {
    @Volatile private var enabledAtUptimeMs: Long = Long.MAX_VALUE
    @Volatile private var disabledAtUptimeMs: Long = Long.MIN_VALUE
    private val activePointers = linkedSetOf<Int>()

    @Synchronized
    fun configure(enabledAtUptimeMs: Long, disabledAtUptimeMs: Long) {
        require(enabledAtUptimeMs >= 0)
        require(disabledAtUptimeMs > enabledAtUptimeMs)
        this.enabledAtUptimeMs = enabledAtUptimeMs
        this.disabledAtUptimeMs = disabledAtUptimeMs
        activePointers.clear()
    }

    @Synchronized
    fun close() {
        disabledAtUptimeMs = Long.MIN_VALUE
        activePointers.clear()
    }

    @Synchronized
    fun shouldForward(event: MotionEvent): Boolean {
        val time = event.eventTime
        val inWindow = time >= enabledAtUptimeMs && time < disabledAtUptimeMs
        return when (event.actionMasked) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> {
                val pointerId = event.getPointerId(event.actionIndex)
                if (!inWindow || pointerId in activePointers || activePointers.size >= 10) false
                else activePointers.add(pointerId)
            }
            MotionEvent.ACTION_MOVE -> {
                inWindow && (0 until event.pointerCount).all { event.getPointerId(it) in activePointers }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_POINTER_UP -> {
                val pointerId = event.getPointerId(event.actionIndex)
                val known = activePointers.remove(pointerId)
                known && inWindow
            }
            MotionEvent.ACTION_CANCEL -> {
                activePointers.clear()
                false
            }
            else -> false
        }
    }
}

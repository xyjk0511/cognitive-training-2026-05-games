package com.a620.tablet.training

import android.view.MotionEvent
import a620.shell.TouchPointerAction
import a620.shell.PointerGateDecision
import a620.shell.PointerInputGate
import a620.shell.PointerInputSample

/**
 * Native-side half-open gate using MotionEvent.eventTime (uptime ms).
 * CANCEL_STREAM means the adapter must deliver/synthesize ACTION_CANCEL to
 * Cocos before discarding further events from the old gesture.
 */
class AndroidTouchInputGate {
    private val gate = PointerInputGate(RuntimePolicy.MAX_POINTERS)

    @Synchronized
    fun configure(enabledAtUptimeMs: Long, disabledAtUptimeMs: Long): PointerGateDecision =
        gate.configure(enabledAtUptimeMs, disabledAtUptimeMs)

    @Synchronized
    fun close(): PointerGateDecision = gate.close()

    @Synchronized
    fun evaluate(event: MotionEvent): PointerGateDecision {
        val action = when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> TouchPointerAction.DOWN
            MotionEvent.ACTION_POINTER_DOWN -> TouchPointerAction.POINTER_DOWN
            MotionEvent.ACTION_MOVE -> TouchPointerAction.MOVE
            MotionEvent.ACTION_UP -> TouchPointerAction.UP
            MotionEvent.ACTION_POINTER_UP -> TouchPointerAction.POINTER_UP
            MotionEvent.ACTION_CANCEL -> TouchPointerAction.CANCEL
            else -> return PointerGateDecision.DROP
        }
        val actionPointerId = when (action) {
            TouchPointerAction.DOWN, TouchPointerAction.POINTER_DOWN,
            TouchPointerAction.UP, TouchPointerAction.POINTER_UP -> event.getPointerId(event.actionIndex)
            else -> null
        }
        val pointerIds = if (action == TouchPointerAction.MOVE) {
            (0 until event.pointerCount).map(event::getPointerId)
        } else emptyList()
        return gate.evaluate(
            PointerInputSample(
                action = action,
                eventTimeUptimeMs = event.eventTime,
                actionPointerId = actionPointerId,
                pointerIds = pointerIds,
            ),
        )
    }
}

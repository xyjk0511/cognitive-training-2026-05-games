package android.view

object Gravity { const val CENTER: Int = 17 }

open class MotionEvent {
    companion object {
        const val ACTION_DOWN = 0
        const val ACTION_UP = 1
        const val ACTION_MOVE = 2
        const val ACTION_CANCEL = 3
        const val ACTION_POINTER_DOWN = 5
        const val ACTION_POINTER_UP = 6
    }
    open val eventTime: Long = 0
    open val actionMasked: Int = ACTION_CANCEL
    open val actionIndex: Int = 0
    open val pointerCount: Int = 0
    open fun getPointerId(index: Int): Int = index
}

@file:Suppress("UNUSED_PARAMETER")

package android.app

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.IBinder

open class Activity : Context() {
    open fun onCreate(savedInstanceState: Bundle?) = Unit
    fun setContentView(view: Any?) = Unit
}

open class Service : Context() {
    open fun onBind(intent: Intent?): IBinder? = null
    open fun onDestroy() = Unit
}

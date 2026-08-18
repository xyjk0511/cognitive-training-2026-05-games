@file:Suppress("UNUSED_PARAMETER")

package android.app

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.IBinder

open class Application : Context() {
    companion object {
        @Volatile private var processNameForTest: String = "com.a620.tablet"

        @JvmStatic fun getProcessName(): String = processNameForTest
        fun setProcessNameForTest(value: String) { processNameForTest = value }
    }

    open fun onCreate() = Unit
    open fun onTerminate() = Unit
}

open class Activity : Context() {
    open fun onCreate(savedInstanceState: Bundle?) = Unit
    fun setContentView(view: Any?) = Unit
}

open class Service : Context() {
    open fun onBind(intent: Intent?): IBinder? = null
    open fun onDestroy() = Unit
}

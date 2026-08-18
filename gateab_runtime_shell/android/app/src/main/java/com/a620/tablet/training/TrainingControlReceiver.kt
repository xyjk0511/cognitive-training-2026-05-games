package com.a620.tablet.training

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.a620.tablet.A620Application

/** Explicit, non-exported bridge for patient controls back to the main-process controller. */
class TrainingControlReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION || intent.component?.className != javaClass.name) return
        val action = intent.getStringExtra(EXTRA_ACTION) ?: return
        if (action !in setOf("PAUSE", "RESUME", "TERMINATE")) return
        (context.applicationContext as A620Application).requestInteractiveControl(action)
    }

    companion object {
        const val ACTION = "com.a620.tablet.action.TRAINING_CONTROL"
        const val EXTRA_ACTION = "controlAction"
    }
}

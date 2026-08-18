package com.a620.tablet

import android.app.Activity
import android.os.Bundle
import android.view.Gravity
import android.widget.TextView

/** Single visible A620 entry. Production navigation is intentionally deferred. */
class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(TextView(this).apply {
            text = getString(R.string.runtime_shell_status)
            gravity = Gravity.CENTER
        })
    }
}

package com.a620.tablet

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.Space
import android.widget.TextView
import com.a620.tablet.training.TrainingActivity

/** Single patient-facing entry for selecting one of the two integrated games. */
class MainActivity : Activity() {
    private lateinit var statusView: TextView
    private lateinit var catchLightButton: Button
    private lateinit var signalStationButton: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.rgb(7, 17, 29)
        window.navigationBarColor = Color.rgb(7, 17, 29)
        setContentView(buildDashboard())
    }

    private fun buildDashboard(): View {
        val padding = dp(40)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(padding, dp(32), padding, dp(28))
            background = GradientDrawable(
                GradientDrawable.Orientation.TL_BR,
                intArrayOf(Color.rgb(7, 17, 29), Color.rgb(10, 34, 51), Color.rgb(8, 24, 39)),
            )
        }
        root.addView(TextView(this).apply {
            text = getString(R.string.dashboard_eyebrow)
            setTextColor(Color.rgb(94, 234, 212))
            textSize = 15f
            typeface = Typeface.DEFAULT_BOLD
            letterSpacing = .12f
        })
        root.addView(TextView(this).apply {
            text = getString(R.string.dashboard_title)
            setTextColor(Color.WHITE)
            textSize = 34f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            setPadding(0, dp(10), 0, dp(8))
        })
        root.addView(TextView(this).apply {
            text = getString(R.string.dashboard_subtitle)
            setTextColor(Color.rgb(148, 163, 184))
            textSize = 17f
            gravity = Gravity.CENTER
        })
        root.addView(Space(this), LinearLayout.LayoutParams(1, 0, 1f))

        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
        }
        catchLightButton = gameButton(
            title = getString(R.string.catch_light_title),
            subtitle = getString(R.string.catch_light_subtitle),
            accent = Color.rgb(13, 148, 136),
        ) { startInteractiveExecution("CATCH_LIGHT") }
        signalStationButton = gameButton(
            title = getString(R.string.signal_station_title),
            subtitle = getString(R.string.signal_station_subtitle),
            accent = Color.rgb(37, 99, 235),
        ) { startInteractiveExecution("SIGNAL_STATION") }
        row.addView(catchLightButton, LinearLayout.LayoutParams(0, dp(245), 1f).apply { marginEnd = dp(14) })
        row.addView(signalStationButton, LinearLayout.LayoutParams(0, dp(245), 1f).apply { marginStart = dp(14) })
        root.addView(row, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(245)))

        root.addView(Space(this), LinearLayout.LayoutParams(1, 0, .8f))
        statusView = TextView(this).apply {
            text = getString(R.string.dashboard_ready)
            setTextColor(Color.rgb(153, 246, 228))
            textSize = 16f
            gravity = Gravity.CENTER
            setPadding(dp(20), dp(14), dp(20), dp(14))
            background = rounded(Color.argb(55, 13, 148, 136), Color.argb(100, 94, 234, 212), 999)
        }
        root.addView(statusView)
        root.addView(TextView(this).apply {
            text = getString(R.string.dashboard_disclaimer)
            setTextColor(Color.rgb(100, 116, 139))
            textSize = 13f
            gravity = Gravity.CENTER
            setPadding(0, dp(16), 0, 0)
        })
        return root
    }

    private fun gameButton(title: String, subtitle: String, accent: Int, onClick: () -> Unit): Button =
        Button(this).apply {
            text = getString(R.string.game_button_format, title, subtitle)
            textSize = 21f
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            isAllCaps = false
            setPadding(dp(28), dp(24), dp(28), dp(24))
            background = rounded(Color.argb(210, Color.red(accent), Color.green(accent), Color.blue(accent)), Color.argb(130, 255, 255, 255), 28)
            setOnClickListener { onClick() }
        }

    private fun startInteractiveExecution(gameCode: String) {
        setButtonsEnabled(false)
        statusView.text = getString(R.string.dashboard_connecting)
        runCatching {
            (application as A620Application).startInteractiveExecution(gameCode) { message ->
                runOnUiThread { statusView.text = message }
            }
            startActivity(Intent(this, TrainingActivity::class.java))
        }.onFailure { error ->
            statusView.text = getString(
                R.string.dashboard_start_failed,
                error.message ?: error::class.java.simpleName,
            )
            setButtonsEnabled(true)
        }
    }

    override fun onResume() {
        super.onResume()
        if (::catchLightButton.isInitialized) setButtonsEnabled(true)
    }

    private fun setButtonsEnabled(enabled: Boolean) {
        catchLightButton.isEnabled = enabled
        signalStationButton.isEnabled = enabled
        catchLightButton.alpha = if (enabled) 1f else .55f
        signalStationButton.alpha = if (enabled) 1f else .55f
    }

    private fun rounded(fill: Int, stroke: Int, radiusDp: Int): GradientDrawable = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        cornerRadius = dp(radiusDp).toFloat()
        setColor(fill)
        setStroke(dp(1), stroke)
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}

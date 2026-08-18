package com.a620.tablet

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.graphics.Color
import android.os.IBinder

/**
 * Keeps the main-process durable controller schedulable while the visible game
 * activity runs in :training. Without this foreground owner Android may freeze
 * the stopped launcher process and delay the authoritative DEADLINE command.
 */
class ControllerKeepAliveService : Service() {
    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                getString(R.string.controller_channel_name),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = getString(R.string.controller_channel_description)
                enableLights(false)
                enableVibration(false)
                lightColor = Color.TRANSPARENT
                setShowBadge(false)
            },
        )
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_a620)
            .setContentTitle(getString(R.string.controller_notification_title))
            .setContentText(getString(R.string.controller_notification_text))
            .setCategory(Notification.CATEGORY_SERVICE)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
        startForeground(NOTIFICATION_ID, notification)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_NOT_STICKY
    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val CHANNEL_ID = "a620-training-controller"
        private const val NOTIFICATION_ID = 620
    }
}

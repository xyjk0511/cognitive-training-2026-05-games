package com.a620.tablet

import android.app.Application
import android.content.Context
import android.os.SystemClock
import android.provider.Settings
import a620.RuntimeWireEnvelope
import com.a620.tablet.training.AndroidControllerStore
import com.a620.tablet.training.AndroidStoreConflict
import com.a620.tablet.training.ControllerRuntimeFactory
import com.a620.tablet.training.ControllerRuntimeSession
import java.io.File

/** Stable Android boot identity used to fence monotonic uptime across restarts. */
internal object AndroidBootEpoch {
    fun read(context: Context): String {
        val bootId = runCatching {
            File("/proc/sys/kernel/random/boot_id").readText().trim().lowercase()
                .takeIf { it.matches(Regex("^[0-9a-f-]{16,64}$")) }
        }.getOrNull()
        val bootCount = runCatching {
            Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT, -1)
        }.getOrDefault(-1)
        return when {
            bootId != null -> "android-boot-$bootId"
            bootCount >= 0 -> "android-boot-count-$bootCount"
            else -> throw AndroidStoreConflict("stable Android boot epoch unavailable; fail closed")
        }
    }
}

/**
 * Main-process owner of the application-private durability core. One execution
 * attempt is active at a time; a dead/terminal attempt must be replaced rather
 * than rebound as though it had resumed.
 */
class PersistentPlatformController(
    context: Context,
    private val store: AndroidControllerStore = AndroidControllerStore(context.applicationContext),
) : AutoCloseable {
    private val appContext = context.applicationContext
    private val bootEpochId = AndroidBootEpoch.read(appContext)
    private var activeSession: ControllerRuntimeSession? = null

    init {
        // Force helper open/migration/onOpen checks before any task is accepted.
        store.writableDatabase
        val startupUtcMs = System.currentTimeMillis()
        val startupUptimeMs = SystemClock.uptimeMillis()
        store.bindBootEpoch(
            bootEpochId = bootEpochId,
            nowUtcMs = startupUtcMs,
            nowUptimeMs = startupUptimeMs,
        )
        store.interruptActiveRuntimesOnControllerStartup(
            nowUtcMs = startupUtcMs,
            nowUptimeMs = startupUptimeMs,
        )
        store.verifyDurabilityInvariants()
    }

    @Synchronized
    fun startExecution(
        prepareEnvelope: RuntimeWireEnvelope,
        canonicalPrepare: ByteArray,
    ): ControllerRuntimeSession {
        check(activeSession == null) { "another execution attempt is already owned by the controller" }
        require(prepareEnvelope.monotonicEpochId == bootEpochId) {
            "PREPARE monotonicEpochId must equal the current Android boot epoch"
        }
        val session = ControllerRuntimeFactory(appContext, store).create(
            prepareEnvelope = prepareEnvelope,
            canonicalPrepare = canonicalPrepare,
            bootEpochId = bootEpochId,
            nowUtcMs = System.currentTimeMillis(),
            nowUptimeMs = SystemClock.uptimeMillis(),
        )
        if (!session.client.bind()) {
            session.close()
            throw AndroidStoreConflict("training process bind was rejected")
        }
        activeSession = session
        return session
    }

    @Synchronized
    fun releaseExecution(session: ControllerRuntimeSession) {
        if (activeSession !== session) return
        activeSession = null
        session.close()
        store.verifyDurabilityInvariants()
    }

    @Synchronized
    fun verifyNow() = store.verifyDurabilityInvariants()

    @Synchronized
    override fun close() {
        activeSession?.close()
        activeSession = null
        store.close()
    }
}

class A620Application : Application() {
    private var ownedPlatformController: PersistentPlatformController? = null

    /** Only the APK main process may own durable controller state. */
    val platformController: PersistentPlatformController
        get() = requireNotNull(ownedPlatformController) {
            "platform controller is unavailable outside the APK main process"
        }

    override fun onCreate() {
        super.onCreate()
        if (Application.getProcessName() == packageName) {
            ownedPlatformController = PersistentPlatformController(this)
        }
    }

    internal fun ownsPlatformControllerForTest(): Boolean = ownedPlatformController != null

    // Android production does not normally call this; it keeps local/JVM lifecycle deterministic.
    override fun onTerminate() {
        ownedPlatformController?.close()
        ownedPlatformController = null
        super.onTerminate()
    }
}

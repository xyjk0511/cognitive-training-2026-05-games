package com.a620.tablet.training

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import a620.CanonicalJson
import a620.RuntimeWireEnvelope
import a620.RuntimeWireEnvelopeParser
import com.a620.tablet.A620Application
import com.a620.tablet.AndroidBootEpoch
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

internal data class GameLaunchSpec(
    val gameCode: String,
    val displayName: String,
    val configAsset: String,
    val packageVersion: String,
    val scoringRuleVersion: String,
    val generatorVersion: String,
    val configSchemaId: String,
    val designMaxLevel: Long,
    val startLevel: Long,
) {
    companion object {
        fun forCode(code: String): GameLaunchSpec = when (code) {
            "CATCH_LIGHT" -> GameLaunchSpec(
                code, "捕光行动", "game-config/catch-light.json", "1.5.0",
                "catch-light-score-1.5", "catch-light-gen-1.5-w2",
                "urn:a620:catch-light:game-config:1.5", 120, 1,
            )
            "SIGNAL_STATION" -> GameLaunchSpec(
                code, "信号反应站", "game-config/signal-station.json", "1.2.1",
                "signal-station-score-1.2.1", "signal-station-gen-1.2.1-r2",
                "urn:a620:signal-station:game-config:1.2.1", 96, 1,
            )
            else -> error("unsupported gameCode $code")
        }
    }
}

/** Main-process owner of one visible five-minute training execution. */
class InteractiveExecutionController internal constructor(
    private val application: A620Application,
    private val spec: GameLaunchSpec,
    private val statusListener: (String) -> Unit,
) : AutoCloseable {
    private val handler = Handler(Looper.getMainLooper())
    private val closed = AtomicBoolean(false)
    private lateinit var prepare: RuntimeWireEnvelope
    private lateinit var session: ControllerRuntimeSession
    private var effectiveStartUptimeMs = 0L
    private var cutoffUptimeMs = 0L
    private var pausedAtUptimeMs: Long? = null
    private var totalPausedMs = 0L
    private var clockRevision = 0L
    private var runtimeState = "PREPARING"
    private val deadlineRunnable = Runnable { sendDeadlineIfRunning() }

    fun start(): String {
        check(!closed.get())
        val pair = buildPrepare()
        prepare = pair.first
        session = application.platformController.startExecution(
            prepareEnvelope = pair.first,
            canonicalPrepare = pair.second,
            onRuntimeEvent = ::onRuntimeEvent,
        )
        status("正在连接 ${spec.displayName}")
        return prepare.runtimeSessionId
    }

    fun requestControl(action: String) {
        handler.post {
            if (closed.get()) return@post
            runCatching {
                when (action) {
                    "PAUSE" -> pause()
                    "RESUME" -> resume()
                    "TERMINATE" -> terminate("PATIENT_TERMINATE")
                    else -> error("unsupported control action")
                }
            }.onFailure { status("控制请求失败：${it.message ?: it::class.java.simpleName}") }
        }
    }

    private fun onRuntimeEvent(envelope: RuntimeWireEnvelope) {
        handler.post {
            if (closed.get()) return@post
            when (envelope.messageType) {
                "READY" -> {
                    runtimeState = "READY"
                    status("${spec.displayName} 已就绪")
                    sendStart()
                }
                "STARTED" -> {
                    runtimeState = "RUNNING"
                    status("${spec.displayName} 训练中")
                }
                "PAUSED" -> {
                    runtimeState = "PAUSED"
                    status("训练已暂停")
                }
                "RESUMED" -> {
                    runtimeState = "RUNNING"
                    status("训练已继续")
                }
                "BATCH_CLOSED" -> status("已安全保存第 ${envelope.payload["batchOrdinal"]} 批")
                "RESULT_READY" -> {
                    runtimeState = "COMPLETE"
                    handler.removeCallbacks(deadlineRunnable)
                    status("训练结果已写入控制数据库")
                    handler.postDelayed({ close() }, 2_000L)
                }
                "TERMINATED" -> {
                    runtimeState = "TERMINATED"
                    handler.removeCallbacks(deadlineRunnable)
                    status("训练已结束")
                    handler.postDelayed({ close() }, 500L)
                }
                "RUNTIME_ERROR" -> status("训练运行异常")
            }
        }
    }

    private fun sendStart() {
        if (runtimeState != "READY") return
        val now = SystemClock.uptimeMillis()
        effectiveStartUptimeMs = now + 500L
        cutoffUptimeMs = effectiveStartUptimeMs + 300_000L
        totalPausedMs = 0L
        pausedAtUptimeMs = null
        clockRevision = 1L
        sendCommand(
            "START",
            linkedMapOf(
                "effectiveStartUptimeMs" to effectiveStartUptimeMs,
                "cutoffUptimeMs" to cutoffUptimeMs,
                "activeElapsedMs" to 0L,
                "clockRevision" to clockRevision,
                "commandLeadTimeMs" to 500L,
            ),
        )
        runtimeState = "START_SCHEDULED"
        scheduleDeadline()
    }

    private fun pause() {
        check(runtimeState == "RUNNING") { "PAUSE requires RUNNING" }
        val now = SystemClock.uptimeMillis()
        val effective = now + 300L
        val active = activeElapsedAt(effective)
        clockRevision += 1L
        sendCommand(
            "PAUSE",
            linkedMapOf(
                "effectivePauseUptimeMs" to effective,
                "activeElapsedMs" to active,
                "clockRevision" to clockRevision,
                "pauseLeadTimeMs" to 300L,
                "reasonCode" to "PATIENT_PAUSE",
            ),
        )
        pausedAtUptimeMs = effective
        runtimeState = "PAUSE_SCHEDULED"
        handler.removeCallbacks(deadlineRunnable)
    }

    private fun resume() {
        check(runtimeState == "PAUSED") { "RESUME requires PAUSED" }
        val pausedAt = requireNotNull(pausedAtUptimeMs)
        val now = SystemClock.uptimeMillis()
        val resumeAt = now + 3_000L
        val pauseDuration = resumeAt - pausedAt
        val active = activeElapsedAt(pausedAt)
        totalPausedMs += pauseDuration
        cutoffUptimeMs += pauseDuration
        pausedAtUptimeMs = null
        clockRevision += 1L
        sendCommand(
            "RESUME",
            linkedMapOf(
                "countdownMs" to 3_000L,
                "resumeInputEnabledUptimeMs" to resumeAt,
                "cutoffUptimeMs" to cutoffUptimeMs,
                "activeElapsedMs" to active,
                "clockRevision" to clockRevision,
            ),
        )
        runtimeState = "RESUME_SCHEDULED"
        scheduleDeadline()
    }

    private fun sendDeadlineIfRunning() {
        if (closed.get() || runtimeState !in setOf("RUNNING", "START_SCHEDULED", "RESUME_SCHEDULED")) return
        sendCommand(
            "DEADLINE",
            linkedMapOf(
                "cutoffUptimeMs" to cutoffUptimeMs,
                "activeElapsedMs" to 300_000L,
                "clockRevision" to clockRevision,
            ),
        )
        runtimeState = "FINALIZING"
        status("正在结算训练结果")
    }

    private fun terminate(reason: String) {
        if (runtimeState in setOf("COMPLETE", "TERMINATED", "FINALIZING")) return
        handler.removeCallbacks(deadlineRunnable)
        val effective = SystemClock.uptimeMillis() + 200L
        clockRevision = maxOf(1L, clockRevision + 1L)
        sendCommand(
            "TERMINATE",
            linkedMapOf(
                "effectiveTerminateUptimeMs" to effective,
                "clockRevision" to clockRevision,
                "reasonCode" to reason,
            ),
        )
        runtimeState = "TERMINATING"
    }

    private fun activeElapsedAt(atUptimeMs: Long): Long {
        if (effectiveStartUptimeMs == 0L) return 0L
        return (atUptimeMs - effectiveStartUptimeMs - totalPausedMs).coerceIn(0L, 300_000L)
    }

    private fun scheduleDeadline() {
        handler.removeCallbacks(deadlineRunnable)
        handler.postAtTime(deadlineRunnable, cutoffUptimeMs)
    }

    private fun sendCommand(messageType: String, payload: Map<String, Any?>) {
        val senderSeq = session.store.reserveNextControllerSenderSeq(prepare.runtimeSessionId)
        val nowUptime = SystemClock.uptimeMillis()
        val value = linkedMapOf<String, Any?>(
            "contractVersion" to prepare.contractVersion,
            "messageType" to messageType,
            "messageId" to "CMD-${prepare.runtimeSessionId.takeLast(24)}-$senderSeq",
            "correlationId" to null,
            "senderRole" to "ANDROID_CONTROLLER",
            "senderSeq" to senderSeq,
            "sentAtUtc" to Instant.now().toString(),
            "sentAtUptimeMs" to nowUptime,
            "monotonicEpochId" to prepare.monotonicEpochId,
            "systemId" to prepare.systemId,
            "deviceId" to prepare.deviceId,
            "taskId" to prepare.taskId,
            "taskItemId" to prepare.taskItemId,
            "executionAttempt" to prepare.executionAttempt,
            "runtimeSessionId" to prepare.runtimeSessionId,
            "packageVersion" to prepare.packageVersion,
            "coreProtocolVersion" to prepare.coreProtocolVersion,
            "payload" to LinkedHashMap(payload),
        )
        val bytes = CanonicalJson.canonicalBytes(value)
        val envelope = RuntimeWireEnvelopeParser.parseCanonical(bytes, expectedSenderRole = "ANDROID_CONTROLLER")
        session.send(envelope, bytes)
    }

    @SuppressLint("ApplySharedPref") // Execution identity must be durable before PREPARE is accepted.
    private fun buildPrepare(): Pair<RuntimeWireEnvelope, ByteArray> {
        val config = loadJsonObject(application, spec.configAsset)
        val configHash = CanonicalJson.sha256(config)
        val preferences = application.getSharedPreferences("a620-execution", Context.MODE_PRIVATE)
        val attempt = preferences.getLong("next-attempt", 0L) + 1L
        val installationId = preferences.getString("installation-id", null)
            ?: UUID.randomUUID().toString().replace("-", "").take(32)
        check(
            preferences.edit()
                .putLong("next-attempt", attempt)
                .putString("installation-id", installationId)
                .commit(),
        ) { "failed to persist execution identity" }
        val runtimeSessionId = "RUN-${UUID.randomUUID()}"
        val nowUptime = SystemClock.uptimeMillis()
        val value = linkedMapOf<String, Any?>(
            "contractVersion" to "A620-TRC-1.1",
            "messageType" to "PREPARE",
            "messageId" to "PREP-${UUID.randomUUID()}",
            "correlationId" to null,
            "senderRole" to "ANDROID_CONTROLLER",
            "senderSeq" to 1L,
            "sentAtUtc" to Instant.now().toString(),
            "sentAtUptimeMs" to nowUptime,
            "monotonicEpochId" to AndroidBootEpoch.read(application),
            "systemId" to "A620-LOCAL",
            "deviceId" to "TAB-$installationId",
            "taskId" to "LOCAL-${spec.gameCode}",
            "taskItemId" to "LOCAL-${spec.gameCode}-$attempt",
            "executionAttempt" to attempt,
            "runtimeSessionId" to runtimeSessionId,
            "packageVersion" to spec.packageVersion,
            "coreProtocolVersion" to "1.1.0",
            "payload" to linkedMapOf<String, Any?>(
                "clockProfile" to "A620-UPTIME-MS-1",
                "durationMs" to 300_000L,
                "sessionSeed" to (System.currentTimeMillis() and 0xffff_ffffL),
                "sessionStartLevel" to spec.startLevel,
                "designMaxLevel" to spec.designMaxLevel,
                "plannedBatchCount" to 8L,
                "runtimeConfigHash" to configHash,
                "scoringRuleVersion" to spec.scoringRuleVersion,
                "resultSchemaVersion" to "A620-TRR-1.1",
                "generatorVersion" to spec.generatorVersion,
                "gameCode" to spec.gameCode,
                "gameConfigSchemaId" to spec.configSchemaId,
                "gameConfig" to config,
            ),
        )
        val bytes = CanonicalJson.canonicalBytes(value)
        return RuntimeWireEnvelopeParser.parseCanonical(bytes, expectedSenderRole = "ANDROID_CONTROLLER") to bytes
    }

    private fun status(message: String) {
        statusListener(message)
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        handler.removeCallbacks(deadlineRunnable)
        if (::session.isInitialized) application.platformController.releaseExecution(session)
        application.clearInteractiveController(this)
    }
}

private fun loadJsonObject(context: Context, assetPath: String): LinkedHashMap<String, Any?> {
    val text = context.assets.open(assetPath).bufferedReader(Charsets.UTF_8).use { it.readText() }
    val parsed = JSONTokener(text).nextValue()
    require(parsed is JSONObject) { "$assetPath must contain an object" }
    @Suppress("UNCHECKED_CAST")
    return jsonValue(parsed) as LinkedHashMap<String, Any?>
}

private fun jsonValue(value: Any?): Any? = when (value) {
    null, JSONObject.NULL -> null
    is JSONObject -> linkedMapOf<String, Any?>().apply {
        value.keys().forEach { key -> put(key, jsonValue(value.get(key))) }
    }
    is JSONArray -> List(value.length()) { index -> jsonValue(value.get(index)) }
    is Boolean, is String -> value
    is Byte, is Short, is Int, is Long -> (value as Number).toLong()
    else -> error("unsupported JSON value ${value::class.java.simpleName}")
}

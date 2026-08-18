package com.a620.tablet.training

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.webkit.JavascriptInterface
import android.webkit.WebView
import a620.CanonicalJson
import a620.RuntimeWireEnvelope
import a620.RuntimeWireEnvelopeParser
import a620.StrictCanonicalJson
import java.security.MessageDigest
import java.time.Instant
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Process-local rendezvous between the authenticated Binder service and the
 * app-owned WebView renderer. Both owners live in the dedicated :training
 * process; no game payload is exposed through an exported Android component.
 */
internal object TrainingUiCoordinator {
    private val lock = Any()
    private var runtime: InteractiveTrainingRuntime? = null
    private var webViewReference: WeakReference<WebView>? = null
    private var webReady = false
    private val pendingCommands = ArrayDeque<String>()

    fun attachRuntime(value: InteractiveTrainingRuntime) = synchronized(lock) {
        runtime = value
        flushLocked()
    }

    fun detachRuntime(value: InteractiveTrainingRuntime) = synchronized(lock) {
        if (runtime === value) {
            runtime = null
            pendingCommands.clear()
        }
    }

    fun attachWebView(value: WebView) = synchronized(lock) {
        webViewReference = WeakReference(value)
        webReady = false
    }

    fun markWebReady(value: WebView) = synchronized(lock) {
        if (webViewReference?.get() !== value) return@synchronized
        webReady = true
        flushLocked()
    }

    fun detachWebView(value: WebView) = synchronized(lock) {
        if (webViewReference?.get() === value) {
            webViewReference?.clear()
            webViewReference = null
            webReady = false
        }
    }

    fun deliverCommand(canonicalCommand: ByteArray) = synchronized(lock) {
        pendingCommands += canonicalCommand.toString(Charsets.UTF_8)
        flushLocked()
    }

    fun emitFromWeb(messageType: String, correlationId: String?, canonicalPayload: String) {
        val target = synchronized(lock) { runtime }
            ?: throw IllegalStateException("training runtime is not connected")
        target.emitFromWeb(messageType, correlationId, canonicalPayload)
    }

    fun reportFatalFromWeb(reason: String) {
        synchronized(lock) { runtime }?.onWebFailure(reason)
    }

    private fun flushLocked() {
        val target = webViewReference?.get() ?: return
        if (!webReady || runtime == null) return
        while (pendingCommands.isNotEmpty()) {
            val command = pendingCommands.removeFirst()
            target.post {
                target.evaluateJavascript(
                    "window.A620Runtime.receiveCommand(${org.json.JSONObject.quote(command)});",
                    null,
                )
            }
        }
    }
}

/** Javascript surface is deliberately tiny and attached only to bundled local content. */
internal class TrainingJavascriptBridge(
    private val context: Context,
    private val webView: WebView,
) {
    @JavascriptInterface
    fun uptimeMs(): Long = SystemClock.uptimeMillis()

    @JavascriptInterface
    fun emitEvent(messageType: String, correlationId: String?, canonicalPayload: String) {
        TrainingUiCoordinator.emitFromWeb(messageType, correlationId, canonicalPayload)
    }

    @JavascriptInterface
    fun reportFatal(reason: String) {
        TrainingUiCoordinator.reportFatalFromWeb(reason.take(240))
    }

    @JavascriptInterface
    fun finishTraining() {
        val activity = context as? android.app.Activity ?: return
        activity.runOnUiThread { activity.finish() }
    }

    @JavascriptInterface
    fun requestControl(action: String) {
        if (action == "WEB_READY") {
            TrainingUiCoordinator.markWebReady(webView)
            return
        }
        require(action in setOf("PAUSE", "RESUME", "TERMINATE")) { "unsupported control action" }
        val request = Intent(TrainingControlReceiver.ACTION).apply {
            component = ComponentName(context.packageName, TrainingControlReceiver::class.java.name)
            setPackage(context.packageName)
            putExtra(TrainingControlReceiver.EXTRA_ACTION, action)
        }
        context.sendBroadcast(request)
    }
}

/**
 * Authenticated runtime adapter for the real Catch Light and Signal Station
 * modules hosted by [TrainingActivity]. Kotlin owns wire identity, ordering and
 * canonical event construction; JavaScript owns game-specific deterministic
 * rules and rendering.
 */
internal class InteractiveTrainingRuntime(
    private val eventSender: DeviceRuntimeEventSender,
    private val interruptionSender: (RuntimeWireEnvelope?, String, Long) -> Unit,
) : RuntimeMessageSink {
    private val terminalNotified = AtomicBoolean(false)
    private var identity: RuntimeWireEnvelope? = null
    private var eventSeq = 0L
    private var lastEventUptimeMs = 0L
    private var cachedResultReady: Pair<RuntimeWireEnvelope, ByteArray>? = null
    private val strict = StrictRuntimeMessageSink(
        onFirstAccepted = { envelope, _ -> identity = envelope },
        onAccepted = ::handleAccepted,
        onTerminal = ::notifyInterrupted,
    )

    init {
        TrainingUiCoordinator.attachRuntime(this)
    }

    override fun onCanonicalMessage(envelope: RuntimeWireEnvelope, canonicalJson: ByteArray) =
        strict.onCanonicalMessage(envelope, canonicalJson)

    override fun onProtocolViolation(messageId: String?, reason: String) = strict.onProtocolViolation(messageId, reason)
    override fun onTelemetryDropped(messageId: String, messageType: String) = strict.onTelemetryDropped(messageId, messageType)
    override fun onStaleChannelMessage(messageId: String?, reason: String) = strict.onStaleChannelMessage(messageId, reason)
    override fun onFatalInfrastructureFailure(reason: String) = strict.onFatalInfrastructureFailure(reason)
    override fun onControllerChannelClosed(reason: String) {
        TrainingUiCoordinator.detachRuntime(this)
        strict.onControllerChannelClosed(reason)
    }

    fun emitFromWeb(messageType: String, correlationId: String?, canonicalPayload: String) {
        val payload = StrictCanonicalJson.parse(canonicalPayload.toByteArray(Charsets.UTF_8))
            as? Map<*, *> ?: error("web event payload must be an object")
        val typedPayload = linkedMapOf<String, Any?>()
        payload.forEach { (key, value) ->
            require(key is String) { "web event payload key must be string" }
            typedPayload[key] = value
        }
        val pair = buildEvent(messageType, correlationId, typedPayload)
        if (messageType == "RESULT_READY") cachedResultReady = pair.first to pair.second.copyOf()
        eventSender.send(pair.first, pair.second)
    }

    fun onWebFailure(reason: String) {
        onFatalInfrastructureFailure("WEB_GAME_RUNTIME_FAILURE:${reason.take(200)}")
    }

    private fun handleAccepted(command: RuntimeWireEnvelope, canonicalJson: ByteArray, replay: Boolean) {
        if (replay && command.messageType == "DEADLINE") {
            cachedResultReady?.let { eventSender.send(it.first, it.second.copyOf()) }
            return
        }
        if (replay) return
        require(canonicalJson.isNotEmpty())
        TrainingUiCoordinator.deliverCommand(canonicalJson)
    }

    private fun buildEvent(
        messageType: String,
        correlationId: String?,
        payload: Map<String, Any?>,
    ): Pair<RuntimeWireEnvelope, ByteArray> {
        val base = requireNotNull(identity) { "PREPARE identity not established" }
        val uptime = maxOf(SystemClock.uptimeMillis(), lastEventUptimeMs + 1L)
        lastEventUptimeMs = uptime
        eventSeq += 1L
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(base.runtimeSessionId.toByteArray())
            .joinToString("") { "%02x".format(it) }
            .take(16)
        val value = linkedMapOf<String, Any?>(
            "contractVersion" to base.contractVersion,
            "messageType" to messageType,
            "messageId" to "WEB-$digest-${eventSeq.toString().padStart(8, '0')}",
            "correlationId" to correlationId,
            "senderRole" to "COCOS_RUNTIME",
            "senderSeq" to eventSeq,
            "sentAtUtc" to Instant.now().toString(),
            "sentAtUptimeMs" to uptime,
            "monotonicEpochId" to base.monotonicEpochId,
            "systemId" to base.systemId,
            "deviceId" to base.deviceId,
            "taskId" to base.taskId,
            "taskItemId" to base.taskItemId,
            "executionAttempt" to base.executionAttempt,
            "runtimeSessionId" to base.runtimeSessionId,
            "packageVersion" to base.packageVersion,
            "coreProtocolVersion" to base.coreProtocolVersion,
            "payload" to LinkedHashMap(payload),
        )
        val bytes = CanonicalJson.canonicalBytes(value)
        val envelope = RuntimeWireEnvelopeParser.parseCanonical(bytes, expectedSenderRole = "COCOS_RUNTIME")
        return envelope to bytes
    }

    private fun notifyInterrupted(reason: String) {
        TrainingUiCoordinator.detachRuntime(this)
        if (!terminalNotified.compareAndSet(false, true)) return
        interruptionSender(identity, reason.take(256), SystemClock.uptimeMillis())
    }
}

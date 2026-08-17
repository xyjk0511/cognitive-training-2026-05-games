package com.a620.tablet.training

import android.content.Context
import a620.RuntimeWireEnvelope
import java.security.MessageDigest

/** Fully wired controller-side runtime handle for one execution attempt. */
class ControllerRuntimeSession(
    val client: ControllerRuntimeClient,
    val store: AndroidControllerStore,
    val eventSink: DurableControllerEventSink,
    val outboxDispatcher: ControllerOutboxDispatcher,
) : AutoCloseable {
    override fun close() {
        client.close("CONTROLLER_RUNTIME_SESSION_CLOSED")
        outboxDispatcher.close()
        store.close()
    }
}

class ControllerRuntimeFactory(
    private val context: Context,
    private val store: AndroidControllerStore = AndroidControllerStore(context),
) {
    fun create(
        prepareEnvelope: RuntimeWireEnvelope,
        canonicalPrepare: ByteArray,
        bootEpochId: String,
        nowUtcMs: Long,
        nowUptimeMs: Long,
    ): ControllerRuntimeSession {
        require(prepareEnvelope.messageType == "PREPARE")
        store.bindBootEpoch(bootEpochId, nowUtcMs, nowUptimeMs)
        store.registerPreparedRuntime(prepareEnvelope, canonicalPrepare, nowUtcMs, nowUptimeMs)

        val sink = DurableControllerEventSink(
            store = store,
            runtimeSessionId = prepareEnvelope.runtimeSessionId,
            executionAttempt = prepareEnvelope.executionAttempt,
        )
        lateinit var client: ControllerRuntimeClient
        val outboxDispatcher = ControllerOutboxDispatcher(
            runtimeSessionId = prepareEnvelope.runtimeSessionId,
            store = store,
            sender = CanonicalControllerSender { envelope, bytes ->
                client.submitInline(
                    messageType = envelope.messageType,
                    messageId = envelope.messageId,
                    senderSeq = envelope.senderSeq,
                    canonicalJson = bytes,
                    canonicalSha256 = sha256Hex(bytes),
                )
            },
            onFatalFailure = sink::onFatalInfrastructureFailure,
        )
        client = ControllerRuntimeClient(
            context = context,
            runtimeSessionId = prepareEnvelope.runtimeSessionId,
            executionAttempt = prepareEnvelope.executionAttempt,
            outcomeWriter = store,
            eventSink = sink,
            onChannelAvailable = outboxDispatcher::scheduleDrain,
        )
        val coordinator = ControllerResultCommitCoordinator(
            store = store,
            outboxDispatcher = outboxDispatcher,
        )
        sink.attachResultCoordinator(coordinator)
        return ControllerRuntimeSession(client, store, sink, outboxDispatcher)
    }

    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}

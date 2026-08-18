package com.a620.tablet.training

import android.content.Context
import a620.RuntimeWireEnvelope

/** Fully wired controller-side runtime handle for one execution attempt. */
class ControllerRuntimeSession(
    val client: ControllerRuntimeClient,
    val store: AndroidControllerStore,
    val eventSink: DurableControllerEventSink,
    val outboxDispatcher: ControllerOutboxDispatcher,
    private val commandTransport: ControllerCommandTransport,
    private val closeStoreOnClose: Boolean = false,
) : AutoCloseable {
    override fun close() {
        client.close("CONTROLLER_RUNTIME_SESSION_CLOSED")
        outboxDispatcher.close()
        commandTransport.close()
        if (closeStoreOnClose) store.close()
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
        lateinit var commandTransport: ControllerCommandTransport
        val outboxDispatcher = ControllerOutboxDispatcher(
            runtimeSessionId = prepareEnvelope.runtimeSessionId,
            store = store,
            sender = CanonicalControllerSender { envelope, bytes -> commandTransport.send(envelope, bytes) },
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
        commandTransport = ControllerCommandTransport(
            channel = client,
            onFatalFailure = sink::onFatalInfrastructureFailure,
        )
        val coordinator = ControllerResultCommitCoordinator(
            store = store,
            outboxDispatcher = outboxDispatcher,
        )
        sink.attachResultCoordinator(coordinator)
        return ControllerRuntimeSession(client, store, sink, outboxDispatcher, commandTransport)
    }
}

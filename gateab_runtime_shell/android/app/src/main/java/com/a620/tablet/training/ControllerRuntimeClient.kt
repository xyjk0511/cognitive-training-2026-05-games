package com.a620.tablet.training

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import a620.RuntimeIngressPriority
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

interface ExecutionOutcomeWriter {
    fun recordInterrupted(
        runtimeSessionId: String,
        executionAttempt: Long,
        reason: String,
        observedAtUptimeMs: Long,
    )
}

/**
 * Main-process source scaffold. Runtime callbacks receive the same strict
 * canonical/hash/envelope checks as controller-to-training traffic.
 */
class ControllerRuntimeClient(
    private val context: Context,
    private val runtimeSessionId: String,
    private val executionAttempt: Long,
    private val outcomeWriter: ExecutionOutcomeWriter,
    private val eventSink: RuntimeMessageSink = RejectingPlaceholderSink(),
) : ServiceConnection {
    private val generationCounter = AtomicLong(0)
    private val terminal = AtomicBoolean(false)
    private val connectionLock = Any()
    private val eventActor = TrainingRuntimeActor { error ->
        eventSink.onFatalInfrastructureFailure("CONTROLLER_EVENT_ACTOR_FAILURE: ${error.message ?: error::class.java.simpleName}")
    }
    private val eventIngress = CanonicalIngressCoordinator(
        expectedSenderRole = "COCOS_RUNTIME",
        actor = eventActor,
        sink = eventSink,
        requireLiveGeneration = ::requireLiveGeneration,
    )

    @Volatile private var runtime: ITrainingRuntime? = null
    @Volatile private var currentGeneration = 0L
    @Volatile private var currentBinder: IBinder? = null
    @Volatile private var currentDeathRecipient: IBinder.DeathRecipient? = null
    @Volatile private var bound = false

    private fun handleRuntimeDeath(generation: Long, binder: IBinder?, reason: String) {
        synchronized(connectionLock) {
            if (terminal.get()) return
            if (generation != currentGeneration || (binder != null && currentBinder !== binder)) return
            if (!terminal.compareAndSet(false, true)) return
            runtime = null
            currentDeathRecipient?.let { recipient -> currentBinder?.unlinkToDeath(recipient, 0) }
            currentBinder = null
            currentDeathRecipient = null
        }
        outcomeWriter.recordInterrupted(runtimeSessionId, executionAttempt, reason, SystemClock.uptimeMillis())
        eventIngress.close()
        eventActor.shutdownNow()
    }

    private val callback = object : ITrainingRuntimeCallback.Stub() {
        override fun onInlineEvent(
            messageType: String,
            messageId: String,
            senderSeq: Long,
            canonicalJson: ByteArray,
            canonicalSha256: String,
            channelGeneration: Long,
        ) {
            if (terminal.get() || channelGeneration != currentGeneration) return
            eventIngress.submitInline(
                messageType,
                messageId,
                senderSeq,
                canonicalJson,
                canonicalSha256,
                channelGeneration,
            )
        }

        override fun onBulkEvent(
            messageType: String,
            messageId: String,
            senderSeq: Long,
            payloadFd: ParcelFileDescriptor,
            byteLength: Long,
            canonicalSha256: String,
            channelGeneration: Long,
        ) {
            if (terminal.get() || channelGeneration != currentGeneration) return
            eventIngress.submitBulk(
                messageType,
                messageId,
                senderSeq,
                payloadFd,
                byteLength,
                canonicalSha256,
                channelGeneration,
            )
        }

        override fun onRuntimeInterrupted(
            runtimeSessionId: String,
            executionAttempt: Long,
            reason: String,
            observedAtUptimeMs: Long,
        ) {
            if (runtimeSessionId != this@ControllerRuntimeClient.runtimeSessionId ||
                executionAttempt != this@ControllerRuntimeClient.executionAttempt
            ) return
            try {
                eventActor.submit(RuntimeIngressPriority.URGENT, 1) {
                    if (!terminal.compareAndSet(false, true)) return@submit
                    runtime = null
                    outcomeWriter.recordInterrupted(runtimeSessionId, executionAttempt, reason, observedAtUptimeMs)
                    eventIngress.close()
                    eventActor.shutdownNow()
                }
            } catch (_: Throwable) {
                handleRuntimeDeath(currentGeneration, currentBinder, "CONTROLLER_EVENT_URGENT_LANE_UNAVAILABLE")
            }
        }
    }

    fun bind(): Boolean {
        check(!terminal.get()) { "terminal runtime requires a new execution attempt" }
        val accepted = context.bindService(
            Intent(context, TrainingRuntimeService::class.java),
            this,
            Context.BIND_AUTO_CREATE,
        )
        bound = accepted
        return accepted
    }

    override fun onServiceConnected(name: ComponentName, service: IBinder) {
        synchronized(connectionLock) {
            if (terminal.get()) return
            currentDeathRecipient?.let { old -> currentBinder?.unlinkToDeath(old, 0) }
            val generation = generationCounter.incrementAndGet()
            val recipient = IBinder.DeathRecipient {
                handleRuntimeDeath(generation, service, "TRAINING_PROCESS_DIED")
            }
            service.linkToDeath(recipient, 0)
            currentGeneration = generation
            currentBinder = service
            currentDeathRecipient = recipient
            runtime = ITrainingRuntime.Stub.asInterface(service).also {
                it.registerCallback(callback, generation)
            }
        }
    }

    override fun onServiceDisconnected(name: ComponentName) =
        handleRuntimeDeath(currentGeneration, currentBinder, "TRAINING_PROCESS_DISCONNECTED")

    override fun onBindingDied(name: ComponentName) =
        handleRuntimeDeath(currentGeneration, currentBinder, "TRAINING_BINDING_DIED")

    override fun onNullBinding(name: ComponentName) =
        handleRuntimeDeath(currentGeneration, currentBinder, "TRAINING_NULL_BINDING")

    fun requireRuntime(): ITrainingRuntime {
        check(!terminal.get()) { "runtime is terminal" }
        return requireNotNull(runtime) { "runtime not connected" }
    }

    fun close(reason: String) {
        require(reason.isNotBlank())
        if (terminal.compareAndSet(false, true)) {
            runtime?.closeChannel(currentGeneration, reason)
        }
        synchronized(connectionLock) {
            currentDeathRecipient?.let { currentBinder?.unlinkToDeath(it, 0) }
            currentDeathRecipient = null
            currentBinder = null
            runtime = null
        }
        eventIngress.close()
        eventActor.shutdownNow()
        if (bound) {
            context.unbindService(this)
            bound = false
        }
    }

    private fun requireLiveGeneration(generation: Long) {
        require(!terminal.get() && generation == currentGeneration && runtime != null) {
            "stale or terminal controller event channel"
        }
    }
}

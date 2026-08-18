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
 * Main-process controller for the isolated training process.
 *
 * Every binding receives a fresh opaque channel token. The token is internal
 * transport metadata and never enters the A620 wire envelope, result hash or
 * training package. Callers cannot access the raw AIDL interface; all sends go
 * through methods that attach the current token and generation.
 */
class ControllerRuntimeClient(
    private val context: Context,
    private val runtimeSessionId: String,
    private val executionAttempt: Long,
    private val outcomeWriter: ExecutionOutcomeWriter,
    private val eventSink: RuntimeMessageSink = StrictRuntimeMessageSink(),
    private val onChannelAvailable: () -> Unit = {},
) : ServiceConnection, ControllerCommandChannel {
    private val generationCounter = AtomicLong(0)
    private val terminal = AtomicBoolean(false)
    private val connectionLock = Any()
    private val eventActor = TrainingRuntimeActor { error ->
        eventSink.onFatalInfrastructureFailure(
            "CONTROLLER_EVENT_ACTOR_FAILURE: ${error.message ?: error::class.java.simpleName}",
        )
    }
    private val eventIngress = CanonicalIngressCoordinator(
        expectedSenderRole = "COCOS_RUNTIME",
        actor = eventActor,
        sink = eventSink,
        isLiveChannel = ::isLiveChannel,
    )

    @Volatile private var runtime: ITrainingRuntime? = null
    @Volatile private var currentGeneration = 0L
    @Volatile private var currentChannelToken: String? = null
    @Volatile private var currentChannelTokenDigest: ByteArray? = null
    @Volatile private var currentBinder: IBinder? = null
    @Volatile private var currentDeathRecipient: IBinder.DeathRecipient? = null
    @Volatile private var bound = false

    private fun handleRuntimeDeath(generation: Long, binder: IBinder?, reason: String) {
        synchronized(connectionLock) {
            if (terminal.get()) return
            if (generation != currentGeneration || (binder != null && currentBinder !== binder)) return
            if (!terminal.compareAndSet(false, true)) return
            clearConnectionLocked()
        }
        recordInterruptionAndClose(reason, SystemClock.uptimeMillis())
    }

    private val callback = object : ITrainingRuntimeCallback.Stub() {
        override fun onInlineEvent(
            messageType: String,
            messageId: String,
            senderSeq: Long,
            canonicalJson: ByteArray,
            canonicalSha256: String,
            channelToken: String,
            channelGeneration: Long,
        ) {
            if (!isLiveChannel(channelGeneration, channelToken)) {
                auditStaleCallback(messageId, "STALE_INLINE_CALLBACK")
                return
            }
            eventIngress.submitInline(
                messageType,
                messageId,
                senderSeq,
                canonicalJson,
                canonicalSha256,
                channelGeneration,
                channelToken,
            )
        }

        override fun onBulkEvent(
            messageType: String,
            messageId: String,
            senderSeq: Long,
            payloadFd: ParcelFileDescriptor,
            byteLength: Long,
            canonicalSha256: String,
            channelToken: String,
            channelGeneration: Long,
        ) {
            payloadFd.use { inbound ->
                if (!isLiveChannel(channelGeneration, channelToken)) {
                    auditStaleCallback(messageId, "STALE_BULK_CALLBACK")
                    return
                }
                eventIngress.submitBulk(
                    messageType,
                    messageId,
                    senderSeq,
                    inbound,
                    byteLength,
                    canonicalSha256,
                    channelGeneration,
                    channelToken,
                )
            }
        }

        override fun onRuntimeInterrupted(
            runtimeSessionId: String,
            executionAttempt: Long,
            reason: String,
            observedAtUptimeMs: Long,
            channelToken: String,
            channelGeneration: Long,
        ) {
            if (!isLiveChannel(channelGeneration, channelToken)) {
                auditStaleCallback(null, "STALE_INTERRUPTED_CALLBACK")
                return
            }
            if (runtimeSessionId != this@ControllerRuntimeClient.runtimeSessionId ||
                executionAttempt != this@ControllerRuntimeClient.executionAttempt
            ) return
            try {
                eventActor.submit(RuntimeIngressPriority.URGENT, 1) {
                    if (!isLiveChannel(channelGeneration, channelToken)) return@submit
                    if (!terminal.compareAndSet(false, true)) return@submit
                    synchronized(connectionLock) { clearConnectionLocked() }
                    recordInterruptionAndClose(reason, observedAtUptimeMs)
                }
            } catch (_: Throwable) {
                handleRuntimeDeath(currentGeneration, currentBinder, "CONTROLLER_EVENT_URGENT_LANE_UNAVAILABLE")
            }
        }
    }

    fun bind(): Boolean {
        synchronized(connectionLock) {
            check(!terminal.get()) { "terminal runtime requires a new execution attempt" }
            check(!bound) { "runtime client is already bound or binding" }
            val accepted = context.bindService(
                Intent(context, TrainingRuntimeService::class.java),
                this,
                Context.BIND_AUTO_CREATE,
            )
            bound = accepted
            return accepted
        }
    }

    override fun onServiceConnected(name: ComponentName, service: IBinder) {
        if (terminal.get()) return
        val generation = generationCounter.incrementAndGet()
        val token = ChannelAuthenticator.generateToken()
        val tokenDigest = ChannelAuthenticator.digest(token)
        val connected = ITrainingRuntime.Stub.asInterface(service)
        val recipient = IBinder.DeathRecipient {
            handleRuntimeDeath(generation, service, "TRAINING_PROCESS_DIED")
        }
        try {
            service.linkToDeath(recipient, 0)
            synchronized(connectionLock) {
                if (terminal.get()) {
                    service.unlinkToDeath(recipient, 0)
                    return
                }
                clearConnectionLocked()
                currentChannelToken = token
                currentChannelTokenDigest = tokenDigest
                currentBinder = service
                currentDeathRecipient = recipient
                runtime = connected
                // Publish the volatile generation last. Readers that observe it
                // also observe the complete token/binder/runtime channel state.
                currentGeneration = generation
            }
            // Fields are installed before the two-way registration call so a
            // future implementation may safely emit a synchronous registration ACK.
            connected.registerCallback(callback, token, generation)
            onChannelAvailable()
        } catch (error: Throwable) {
            handleRuntimeDeath(generation, service, "CALLBACK_REGISTRATION_FAILED:${error::class.java.simpleName}")
        }
    }

    override fun onServiceDisconnected(name: ComponentName) =
        handleRuntimeDeath(currentGeneration, currentBinder, "TRAINING_PROCESS_DISCONNECTED")

    override fun onBindingDied(name: ComponentName) =
        handleRuntimeDeath(currentGeneration, currentBinder, "TRAINING_BINDING_DIED")

    override fun onNullBinding(name: ComponentName) =
        handleRuntimeDeath(currentGeneration, currentBinder, "TRAINING_NULL_BINDING")

    override fun submitInline(
        messageType: String,
        messageId: String,
        senderSeq: Long,
        canonicalJson: ByteArray,
        canonicalSha256: String,
    ) {
        val channel = requireChannel()
        channel.runtime.submitInline(
            messageType,
            messageId,
            senderSeq,
            canonicalJson,
            canonicalSha256,
            channel.token,
            channel.generation,
        )
    }

    /** The caller retains ownership of [payloadFd]. */
    override fun submitBulk(
        messageType: String,
        messageId: String,
        senderSeq: Long,
        payloadFd: ParcelFileDescriptor,
        byteLength: Long,
        canonicalSha256: String,
    ) {
        val channel = requireChannel()
        channel.runtime.submitBulk(
            messageType,
            messageId,
            senderSeq,
            payloadFd,
            byteLength,
            canonicalSha256,
            channel.token,
            channel.generation,
        )
    }

    fun close(reason: String) {
        require(reason.isNotBlank())
        val becameTerminal: Boolean
        val channel = synchronized(connectionLock) {
            becameTerminal = terminal.compareAndSet(false, true)
            if (becameTerminal) currentChannelOrNull() else null
        }
        if (channel != null) {
            try {
                channel.runtime.closeChannel(channel.token, channel.generation, reason)
            } catch (_: Throwable) {
                // The durable local outcome remains authoritative.
            }
        }
        synchronized(connectionLock) { clearConnectionLocked() }
        if (becameTerminal) {
            recordInterruptionAndClose(reason.take(256), SystemClock.uptimeMillis())
        } else {
            eventIngress.close()
            eventActor.shutdownNow()
        }
        if (bound) {
            context.unbindService(this)
            bound = false
        }
    }

    /**
     * Persist the interruption before tearing down local executors, but always
     * release descriptors and actor threads even when durable outcome storage
     * fails or the runtime was already finalized with a formal result.
     */
    private fun recordInterruptionAndClose(reason: String, observedAtUptimeMs: Long) {
        try {
            outcomeWriter.recordInterrupted(
                runtimeSessionId,
                executionAttempt,
                reason.take(256),
                observedAtUptimeMs,
            )
        } catch (error: Throwable) {
            // A result may already be committed, or durable storage may be
            // unavailable. Never allow that failure to leak the old channel,
            // PFD readers or actor thread. The durable sink preserves COMPLETE
            // and records the infrastructure conflict when possible.
            runCatching {
                eventSink.onFatalInfrastructureFailure(
                    "INTERRUPTION_PERSIST_FAILED:${error.message ?: error::class.java.simpleName}",
                )
            }
        } finally {
            eventIngress.close()
            eventActor.shutdownNow()
        }
    }

    private fun auditStaleCallback(messageId: String?, reason: String) {
        try {
            eventActor.submit(RuntimeIngressPriority.URGENT, 1) {
                eventSink.onStaleChannelMessage(messageId, reason)
            }
        } catch (_: Throwable) {
            // Stale-channel audit must never revive or destabilize a terminal runtime.
        }
    }

    private data class Channel(
        val runtime: ITrainingRuntime,
        val token: String,
        val generation: Long,
    )

    private fun requireChannel(): Channel = synchronized(connectionLock) {
        check(!terminal.get()) { "runtime is terminal" }
        requireNotNull(currentChannelOrNull()) { "runtime not connected" }
    }

    private fun currentChannelOrNull(): Channel? {
        val currentRuntime = runtime ?: return null
        val token = currentChannelToken ?: return null
        if (currentGeneration <= 0L) return null
        return Channel(currentRuntime, token, currentGeneration)
    }

    private fun isLiveChannel(generation: Long, token: String): Boolean =
        !terminal.get() &&
            generation == currentGeneration &&
            runtime != null &&
            ChannelAuthenticator.matches(token, currentChannelTokenDigest)

    private fun clearConnectionLocked() {
        // Invalidate readers before tearing down the remaining channel fields.
        currentGeneration = 0L
        currentDeathRecipient?.let { currentBinder?.unlinkToDeath(it, 0) }
        currentDeathRecipient = null
        currentBinder = null
        runtime = null
        currentChannelToken = null
        currentChannelTokenDigest?.fill(0)
        currentChannelTokenDigest = null
    }
}

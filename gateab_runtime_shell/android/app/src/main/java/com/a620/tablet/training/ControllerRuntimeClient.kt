package com.a620.tablet.training

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import android.os.ParcelFileDescriptor
import android.os.SystemClock
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
 * Main-process source scaffold. Binder death never resumes the same attempt;
 * it records INTERRUPTED and leaves the treatment flow to create a new attempt.
 */
class ControllerRuntimeClient(
    private val context: Context,
    private val runtimeSessionId: String,
    private val executionAttempt: Long,
    private val outcomeWriter: ExecutionOutcomeWriter,
) : ServiceConnection {
    private val generationCounter = AtomicLong(0)
    private val terminal = AtomicBoolean(false)
    private val connectionLock = Any()

    @Volatile private var runtime: ITrainingRuntime? = null
    @Volatile private var currentGeneration = 0L
    @Volatile private var currentBinder: IBinder? = null
    @Volatile private var currentDeathRecipient: IBinder.DeathRecipient? = null
    @Volatile private var bound = false

    private fun handleRuntimeDeath(generation: Long, binder: IBinder?, reason: String) {
        synchronized(connectionLock) {
            if (terminal.get()) return
            // An old service's delayed death callback cannot terminate a newer channel.
            if (generation != currentGeneration || (binder != null && currentBinder !== binder)) return
            if (!terminal.compareAndSet(false, true)) return
            runtime = null
            currentDeathRecipient?.let { recipient -> currentBinder?.unlinkToDeath(recipient, 0) }
            currentBinder = null
            currentDeathRecipient = null
        }
        outcomeWriter.recordInterrupted(
            runtimeSessionId,
            executionAttempt,
            reason,
            SystemClock.uptimeMillis(),
        )
    }

    private val callback = object : ITrainingRuntimeCallback.Stub() {
        override fun onInlineEvent(canonicalJson: ByteArray, canonicalSha256: String, channelGeneration: Long) {
            if (terminal.get() || channelGeneration != currentGeneration) return
            // Production implementation must enqueue into the controller's
            // durable inbox/reducer transaction, not mutate UI on a Binder thread.
        }

        override fun onBulkEvent(
            payloadFd: ParcelFileDescriptor,
            byteLength: Long,
            canonicalSha256: String,
            channelGeneration: Long,
        ) {
            if (terminal.get() || channelGeneration != currentGeneration) return
            // Duplicate before asynchronous use, mirroring the service side.
            ParcelFileDescriptor.dup(payloadFd.fileDescriptor).use { _ ->
                // Production code must queue and hash-verify ownedFd before use.
            }
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
            if (!terminal.compareAndSet(false, true)) return
            runtime = null
            outcomeWriter.recordInterrupted(
                runtimeSessionId,
                executionAttempt,
                reason,
                observedAtUptimeMs,
            )
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

    override fun onServiceDisconnected(name: ComponentName) {
        handleRuntimeDeath(currentGeneration, currentBinder, "TRAINING_PROCESS_DISCONNECTED")
    }

    override fun onBindingDied(name: ComponentName) {
        handleRuntimeDeath(currentGeneration, currentBinder, "TRAINING_BINDING_DIED")
    }

    override fun onNullBinding(name: ComponentName) {
        handleRuntimeDeath(currentGeneration, currentBinder, "TRAINING_NULL_BINDING")
    }

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
        if (bound) {
            context.unbindService(this)
            bound = false
        }
    }
}

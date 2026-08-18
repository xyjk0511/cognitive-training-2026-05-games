package android.os

import java.io.Closeable
import java.io.FileDescriptor
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.io.PipedInputStream
import java.io.PipedOutputStream
import java.util.Collections
import java.util.IdentityHashMap
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

open class Bundle

interface IBinder {
    fun interface DeathRecipient { fun binderDied() }
    fun linkToDeath(recipient: DeathRecipient, flags: Int) = Unit
    fun unlinkToDeath(recipient: DeathRecipient, flags: Int): Boolean = true
}

open class Binder : IBinder {
    private val deathRecipients = CopyOnWriteArraySet<IBinder.DeathRecipient>()

    override fun linkToDeath(recipient: IBinder.DeathRecipient, flags: Int) {
        deathRecipients += recipient
    }

    override fun unlinkToDeath(recipient: IBinder.DeathRecipient, flags: Int): Boolean =
        deathRecipients.remove(recipient)

    fun killForTest() {
        val recipients = deathRecipients.toList()
        deathRecipients.clear()
        recipients.forEach(IBinder.DeathRecipient::binderDied)
    }

    companion object {
        @Volatile private var callingUid: Int = 1000
        fun getCallingUid(): Int = callingUid
        fun setCallingUidForTest(uid: Int) { callingUid = uid }
    }
}

/**
 * Connected, reference-counted JVM model of Android ParcelFileDescriptor.
 * It is intentionally small, but unlike the old placeholder it exercises real
 * pipe blocking/EOF, dup ownership and descriptor closure in the stub tests.
 */
class ParcelFileDescriptor private constructor(
    val fileDescriptor: FileDescriptor,
    private val endpoint: Endpoint,
) : Closeable {
    private class Endpoint(
        val input: InputStream? = null,
        val output: OutputStream? = null,
    ) {
        private val references = AtomicInteger(0)
        fun retain() { references.incrementAndGet() }
        fun release() {
            if (references.decrementAndGet() == 0) {
                try { input?.close() } catch (_: Throwable) { }
                try { output?.close() } catch (_: Throwable) { }
            }
        }
    }

    private val closed = AtomicBoolean(false)
    val isClosed: Boolean get() = closed.get()

    init {
        endpoint.retain()
        synchronized(registry) { registry[fileDescriptor] = endpoint }
        activeDescriptors.incrementAndGet()
    }

    constructor(fileDescriptor: FileDescriptor = FileDescriptor()) : this(
        fileDescriptor,
        synchronized(registry) { registry[fileDescriptor] } ?: Endpoint(),
    )

    companion object {
        private val registry = Collections.synchronizedMap(
            IdentityHashMap<FileDescriptor, Endpoint>(),
        )
        private val activeDescriptors = AtomicInteger(0)

        private fun wrap(endpoint: Endpoint): ParcelFileDescriptor =
            ParcelFileDescriptor(FileDescriptor(), endpoint)

        fun dup(fd: FileDescriptor): ParcelFileDescriptor {
            val endpoint = synchronized(registry) { registry[fd] }
                ?: throw IOException("unknown or closed file descriptor")
            return wrap(endpoint)
        }

        fun createPipe(): Array<ParcelFileDescriptor> {
            val input = PipedInputStream(64 * 1024)
            val output = PipedOutputStream(input)
            return arrayOf(
                wrap(Endpoint(input = input)),
                wrap(Endpoint(output = output)),
            )
        }

        fun activeDescriptorCountForTest(): Int = activeDescriptors.get()
    }

    class AutoCloseInputStream(
        private val descriptor: ParcelFileDescriptor,
    ) : InputStream() {
        private val delegate = descriptor.endpoint.input
            ?: throw IOException("descriptor is not readable")
        override fun read(): Int = delegate.read()
        override fun read(buffer: ByteArray, offset: Int, length: Int): Int =
            delegate.read(buffer, offset, length)
        override fun available(): Int = delegate.available()
        override fun close() = descriptor.close()
    }

    class AutoCloseOutputStream(
        private val descriptor: ParcelFileDescriptor,
    ) : OutputStream() {
        private val delegate = descriptor.endpoint.output
            ?: throw IOException("descriptor is not writable")
        override fun write(value: Int) = delegate.write(value)
        override fun write(buffer: ByteArray, offset: Int, length: Int) =
            delegate.write(buffer, offset, length)
        override fun flush() = delegate.flush()
        override fun close() = descriptor.close()
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        synchronized(registry) { registry.remove(fileDescriptor) }
        endpoint.release()
        activeDescriptors.decrementAndGet()
    }
}

object SystemClock {
    private val originNanos = System.nanoTime()
    fun uptimeMillis(): Long = (System.nanoTime() - originNanos) / 1_000_000L
}

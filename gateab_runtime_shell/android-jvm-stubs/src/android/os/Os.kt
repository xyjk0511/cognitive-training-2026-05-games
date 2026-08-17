package android.os

import java.io.Closeable
import java.io.FileDescriptor
import java.io.FileInputStream
import java.io.FileOutputStream

open class Bundle

interface IBinder {
    fun interface DeathRecipient { fun binderDied() }
    fun linkToDeath(recipient: DeathRecipient, flags: Int) = Unit
    fun unlinkToDeath(recipient: DeathRecipient, flags: Int): Boolean = true
}

open class Binder : IBinder {
    companion object { fun getCallingUid(): Int = 1000 }
}

class ParcelFileDescriptor(val fileDescriptor: FileDescriptor = FileDescriptor()) : Closeable {
    var isClosed: Boolean = false
        private set
    companion object {
        fun dup(fd: FileDescriptor): ParcelFileDescriptor = ParcelFileDescriptor(fd)
        fun createPipe(): Array<ParcelFileDescriptor> = arrayOf(ParcelFileDescriptor(), ParcelFileDescriptor())
    }
    class AutoCloseInputStream(private val descriptor: ParcelFileDescriptor) : FileInputStream(descriptor.fileDescriptor) {
        override fun close() {
            try { super.close() } finally { descriptor.close() }
        }
    }
    class AutoCloseOutputStream(private val descriptor: ParcelFileDescriptor) : FileOutputStream(descriptor.fileDescriptor) {
        override fun close() {
            try { super.close() } finally { descriptor.close() }
        }
    }
    override fun close() { isClosed = true }
}

object SystemClock { fun uptimeMillis(): Long = 0L }

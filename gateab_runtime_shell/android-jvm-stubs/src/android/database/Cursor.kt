package android.database

import java.io.Closeable

open class Cursor : Closeable {
    open fun moveToFirst(): Boolean = false
    open fun moveToNext(): Boolean = false
    open fun getString(index: Int): String = ""
    open fun getLong(index: Int): Long = 0L
    open fun getBlob(index: Int): ByteArray = byteArrayOf()
    open fun isNull(index: Int): Boolean = true
    override fun close() = Unit
}

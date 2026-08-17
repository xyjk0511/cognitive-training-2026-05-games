package android.content

class ContentValues {
    private val values = linkedMapOf<String, Any?>()
    fun put(key: String, value: String?) { values[key] = value }
    fun put(key: String, value: Long?) { values[key] = value }
    fun put(key: String, value: Int?) { values[key] = value }
    fun put(key: String, value: ByteArray?) { values[key] = value }
    fun putNull(key: String) { values[key] = null }
}

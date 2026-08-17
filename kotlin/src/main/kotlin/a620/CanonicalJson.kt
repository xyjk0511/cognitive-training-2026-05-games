package a620

import java.security.MessageDigest

object CanonicalJson {
    const val SAFE_INTEGER_MAX: Long = 9_007_199_254_740_991L

    private fun compareUtf16(a: String, b: String): Int {
        val len = minOf(a.length, b.length)
        for (i in 0 until len) {
            val diff = a[i].code - b[i].code
            if (diff != 0) return diff
        }
        return a.length - b.length
    }

    private fun requireWellFormedUtf16(value: String) {
        var i = 0
        while (i < value.length) {
            val ch = value[i]
            when {
                Character.isHighSurrogate(ch) -> {
                    require(i + 1 < value.length && Character.isLowSurrogate(value[i + 1])) {
                        "unpaired high surrogate is forbidden"
                    }
                    i += 2
                }
                Character.isLowSurrogate(ch) -> error("unpaired low surrogate is forbidden")
                else -> i += 1
            }
        }
    }

    private fun escape(value: String): String {
        requireWellFormedUtf16(value)
        val out = StringBuilder("\"")
        for (ch in value) {
            when (ch) {
                '"' -> out.append("\\\"")
                '\\' -> out.append("\\\\")
                '\b' -> out.append("\\b")
                '\u000C' -> out.append("\\f")
                '\n' -> out.append("\\n")
                '\r' -> out.append("\\r")
                '\t' -> out.append("\\t")
                else -> if (ch.code < 0x20) out.append("\\u%04x".format(ch.code)) else out.append(ch)
            }
        }
        return out.append('"').toString()
    }

    private fun emit(value: Any?): String = when (value) {
        null -> "null"
        is Boolean -> if (value) "true" else "false"
        is String -> escape(value)
        is Byte, is Short, is Int, is Long -> {
            val n = (value as Number).toLong()
            require(n in -SAFE_INTEGER_MAX..SAFE_INTEGER_MAX) { "integer outside JavaScript safe range" }
            n.toString()
        }
        is Float, is Double -> error("floating-point values are forbidden")
        is List<*> -> value.joinToString(prefix = "[", postfix = "]", separator = ",") { emit(it) }
        is Map<*, *> -> {
            val map = linkedMapOf<String, Any?>()
            for ((rawKey, rawValue) in value.entries) {
                require(rawKey is String) { "object key must be a string" }
                requireWellFormedUtf16(rawKey)
                require(rawKey !in map) { "duplicate object key" }
                map[rawKey] = rawValue
            }
            map.keys.sortedWith(::compareUtf16).joinToString(prefix = "{", postfix = "}", separator = ",") { key -> escape(key) + ":" + emit(map[key]) }
        }
        else -> error("unsupported JSON type ${value::class}")
    }

    fun canonicalString(value: Any?): String = emit(value)
    fun canonicalBytes(value: Any?): ByteArray = canonicalString(value).toByteArray(Charsets.UTF_8)
    fun sha256(value: Any?): String = MessageDigest.getInstance("SHA-256").digest(canonicalBytes(value)).joinToString("") { "%02x".format(it) }
}

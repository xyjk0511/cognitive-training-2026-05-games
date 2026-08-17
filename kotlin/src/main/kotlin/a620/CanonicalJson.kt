package a620

import java.security.MessageDigest
import java.util.Collections
import java.util.IdentityHashMap

object CanonicalJson {
    const val SAFE_INTEGER_MAX: Long = 9_007_199_254_740_991L
    const val MAX_DEPTH: Int = GeneratedRuntimeProfiles.JsonMaxDepth
    const val MAX_TOTAL_NODES: Int = GeneratedRuntimeProfiles.JsonMaxTotalNodes
    const val MAX_OBJECT_MEMBERS: Int = GeneratedRuntimeProfiles.JsonMaxObjectMembers
    const val MAX_ARRAY_ITEMS: Int = GeneratedRuntimeProfiles.JsonMaxArrayItems
    const val MAX_STRING_UTF8_BYTES: Int = GeneratedRuntimeProfiles.JsonMaxStringUtf8Bytes
    const val MAX_OBJECT_KEY_UTF8_BYTES: Int = GeneratedRuntimeProfiles.JsonMaxObjectKeyUtf8Bytes
    const val MAX_TOTAL_STRING_UTF8_BYTES: Int = GeneratedRuntimeProfiles.JsonMaxTotalStringUtf8Bytes

    private class Budget {
        var nodes: Int = 0
        var totalStringBytes: Int = 0
        val activeContainers: MutableSet<Any> = Collections.newSetFromMap(IdentityHashMap())
    }

    private fun compareUtf16(a: String, b: String): Int {
        val len = minOf(a.length, b.length)
        for (i in 0 until len) {
            val diff = a[i].code - b[i].code
            if (diff != 0) return diff
        }
        return a.length - b.length
    }

    private fun requireWellFormedUtf16(value: String, path: String) {
        var i = 0
        while (i < value.length) {
            val ch = value[i]
            when {
                Character.isHighSurrogate(ch) -> {
                    require(i + 1 < value.length && Character.isLowSurrogate(value[i + 1])) {
                        "$path[$i]: unpaired high surrogate is forbidden"
                    }
                    i += 2
                }
                Character.isLowSurrogate(ch) -> error("$path[$i]: unpaired low surrogate is forbidden")
                else -> i += 1
            }
        }
    }

    private fun accountString(value: String, path: String, byteLimit: Int, budget: Budget) {
        requireWellFormedUtf16(value, path)
        val bytes = value.toByteArray(Charsets.UTF_8).size
        require(bytes <= byteLimit) { "$path: UTF-8 string exceeds $byteLimit bytes" }
        budget.totalStringBytes += bytes
        require(budget.totalStringBytes <= MAX_TOTAL_STRING_UTF8_BYTES) {
            "JSON total UTF-8 string budget exceeded"
        }
    }

    private fun validate(value: Any?, path: String = "$", depth: Int = 0, budget: Budget = Budget()) {
        require(depth <= MAX_DEPTH) { "$path: JSON nesting exceeds depth $MAX_DEPTH" }
        budget.nodes += 1
        require(budget.nodes <= MAX_TOTAL_NODES) { "$path: JSON node budget exceeds $MAX_TOTAL_NODES" }

        when (value) {
            null, is Boolean -> return
            is String -> accountString(value, path, MAX_STRING_UTF8_BYTES, budget)
            is Byte, is Short, is Int, is Long -> {
                val n = (value as Number).toLong()
                require(n in -SAFE_INTEGER_MAX..SAFE_INTEGER_MAX) { "$path: integer outside JavaScript safe range" }
            }
            is Float, is Double -> error("$path: floating-point values are forbidden")
            is List<*> -> {
                require(value.size <= MAX_ARRAY_ITEMS) { "$path: array exceeds $MAX_ARRAY_ITEMS items" }
                require(budget.activeContainers.add(value)) { "$path: cyclic JSON value is forbidden" }
                try {
                    value.forEachIndexed { index, child -> validate(child, "$path[$index]", depth + 1, budget) }
                } finally {
                    budget.activeContainers.remove(value)
                }
            }
            is Map<*, *> -> {
                require(value.size <= MAX_OBJECT_MEMBERS) { "$path: object exceeds $MAX_OBJECT_MEMBERS members" }
                require(budget.activeContainers.add(value)) { "$path: cyclic JSON value is forbidden" }
                try {
                    for ((rawKey, child) in value.entries) {
                        require(rawKey is String) { "$path: object key must be a string" }
                        accountString(rawKey, "$path.<key>", MAX_OBJECT_KEY_UTF8_BYTES, budget)
                        validate(child, "$path.$rawKey", depth + 1, budget)
                    }
                } finally {
                    budget.activeContainers.remove(value)
                }
            }
            else -> error("$path: unsupported JSON type ${value::class}")
        }
    }

    private fun escape(value: String): String {
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
        is Byte, is Short, is Int, is Long -> (value as Number).toLong().toString()
        is List<*> -> value.joinToString(prefix = "[", postfix = "]", separator = ",") { emit(it) }
        is Map<*, *> -> {
            val map = linkedMapOf<String, Any?>()
            for ((rawKey, rawValue) in value.entries) {
                require(rawKey is String) { "object key must be a string" }
                require(rawKey !in map) { "duplicate object key" }
                map[rawKey] = rawValue
            }
            map.keys.sortedWith(::compareUtf16).joinToString(prefix = "{", postfix = "}", separator = ",") { key -> escape(key) + ":" + emit(map[key]) }
        }
        else -> error("unsupported JSON type ${value::class}")
    }

    fun validateResources(value: Any?) = validate(value)

    fun canonicalString(value: Any?): String {
        validate(value)
        return emit(value)
    }

    fun canonicalBytes(value: Any?): ByteArray = canonicalString(value).toByteArray(Charsets.UTF_8)
    fun sha256(value: Any?): String = MessageDigest.getInstance("SHA-256").digest(canonicalBytes(value)).joinToString("") { "%02x".format(it) }
}

package a620

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

class CanonicalJsonParseError(message: String) : IllegalArgumentException(message)

/**
 * Strict, allocation-bounded parser for A620-JCS-1 payloads.
 *
 * It rejects malformed UTF-8, duplicate object keys, whitespace, floats,
 * exponents, negative zero and unsafe integers, then requires the received
 * bytes to be byte-for-byte equal to the canonical re-encoding.
 */
object StrictCanonicalJson {
    fun parse(bytes: ByteArray): Any? {
        require(bytes.isNotEmpty()) { "canonical JSON must not be empty" }
        require(bytes.size <= IpcFrame.MAX_PAYLOAD_BYTES) { "canonical JSON exceeds frame limit" }
        val decoder = StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        val text = try {
            decoder.decode(ByteBuffer.wrap(bytes)).toString()
        } catch (error: Exception) {
            throw CanonicalJsonParseError("canonical JSON is not valid UTF-8: ${error.message}")
        }
        val value = Parser(text).parseRoot()
        try {
            CanonicalJson.validateResources(value)
        } catch (error: RuntimeException) {
            throw CanonicalJsonParseError(error.message ?: "JSON resource validation failed")
        }
        val canonical = CanonicalJson.canonicalBytes(value)
        if (!canonical.contentEquals(bytes)) {
            throw CanonicalJsonParseError("payload is valid JSON but not A620-JCS-1 canonical bytes")
        }
        return value
    }

    private class Parser(private val text: String) {
        private var offset = 0
        private var nodes = 0

        fun parseRoot(): Any? {
            val value = parseValue(0)
            if (offset != text.length) fail("trailing data")
            return value
        }

        private fun parseValue(depth: Int): Any? {
            if (depth > CanonicalJson.MAX_DEPTH) fail("nesting exceeds ${CanonicalJson.MAX_DEPTH}")
            nodes += 1
            if (nodes > CanonicalJson.MAX_TOTAL_NODES) fail("node budget exceeded")
            if (offset >= text.length) fail("unexpected end of input")
            return when (text[offset]) {
                'n' -> parseLiteral("null", null)
                't' -> parseLiteral("true", true)
                'f' -> parseLiteral("false", false)
                '"' -> parseString()
                '[' -> parseArray(depth)
                '{' -> parseObject(depth)
                '-', in '0'..'9' -> parseInteger()
                else -> fail("unexpected character ${text[offset].code}")
            }
        }

        private fun parseLiteral(token: String, value: Any?): Any? {
            if (!text.startsWith(token, offset)) fail("invalid literal")
            offset += token.length
            return value
        }

        private fun parseArray(depth: Int): List<Any?> {
            expect('[')
            val out = ArrayList<Any?>()
            if (peek(']')) {
                offset += 1
                return out
            }
            while (true) {
                if (out.size >= CanonicalJson.MAX_ARRAY_ITEMS) fail("array item budget exceeded")
                out += parseValue(depth + 1)
                when {
                    peek(',') -> offset += 1
                    peek(']') -> {
                        offset += 1
                        return out
                    }
                    else -> fail("array requires ',' or ']'")
                }
            }
        }

        private fun parseObject(depth: Int): Map<String, Any?> {
            expect('{')
            val out = LinkedHashMap<String, Any?>()
            if (peek('}')) {
                offset += 1
                return out
            }
            while (true) {
                if (out.size >= CanonicalJson.MAX_OBJECT_MEMBERS) fail("object member budget exceeded")
                if (!peek('"')) fail("object key must be a string")
                val key = parseString()
                if (out.containsKey(key)) fail("duplicate object key: $key")
                expect(':')
                out[key] = parseValue(depth + 1)
                when {
                    peek(',') -> offset += 1
                    peek('}') -> {
                        offset += 1
                        return out
                    }
                    else -> fail("object requires ',' or '}'")
                }
            }
        }

        private fun parseString(): String {
            expect('"')
            val out = StringBuilder()
            while (offset < text.length) {
                val ch = text[offset++]
                when {
                    ch == '"' -> return out.toString()
                    ch == '\\' -> parseEscape(out)
                    ch.code < 0x20 -> fail("unescaped control character in string")
                    Character.isHighSurrogate(ch) -> {
                        if (offset >= text.length || !Character.isLowSurrogate(text[offset])) {
                            fail("unpaired high surrogate")
                        }
                        out.append(ch)
                        out.append(text[offset++])
                    }
                    Character.isLowSurrogate(ch) -> fail("unpaired low surrogate")
                    else -> out.append(ch)
                }
            }
            fail("unterminated string")
        }

        private fun parseEscape(out: StringBuilder) {
            if (offset >= text.length) fail("trailing string escape")
            when (val escaped = text[offset++]) {
                '"', '\\', '/' -> out.append(escaped)
                'b' -> out.append('\b')
                'f' -> out.append('\u000C')
                'n' -> out.append('\n')
                'r' -> out.append('\r')
                't' -> out.append('\t')
                'u' -> {
                    val first = parseHexCodeUnit()
                    when {
                        Character.isHighSurrogate(first) -> {
                            if (offset + 1 >= text.length || text[offset] != '\\' || text[offset + 1] != 'u') {
                                fail("escaped high surrogate must be followed by escaped low surrogate")
                            }
                            offset += 2
                            val second = parseHexCodeUnit()
                            if (!Character.isLowSurrogate(second)) fail("invalid escaped surrogate pair")
                            out.append(first).append(second)
                        }
                        Character.isLowSurrogate(first) -> fail("unpaired escaped low surrogate")
                        else -> out.append(first)
                    }
                }
                else -> fail("invalid string escape: $escaped")
            }
        }

        private fun parseHexCodeUnit(): Char {
            if (offset + 4 > text.length) fail("short unicode escape")
            var value = 0
            repeat(4) {
                val ch = text[offset++]
                val digit = ch.digitToIntOrNull(16) ?: fail("invalid unicode escape")
                value = value * 16 + digit
            }
            return value.toChar()
        }

        private fun parseInteger(): Long {
            val start = offset
            if (peek('-')) offset += 1
            if (offset >= text.length) fail("incomplete number")
            if (text[offset] == '0') {
                offset += 1
                if (offset < text.length && text[offset].isDigit()) fail("leading zero is forbidden")
            } else {
                if (text[offset] !in '1'..'9') fail("invalid integer")
                while (offset < text.length && text[offset].isDigit()) offset += 1
            }
            if (offset < text.length && text[offset] in charArrayOf('.', 'e', 'E', '+')) {
                fail("floating point and exponent notation are forbidden")
            }
            val token = text.substring(start, offset)
            if (token == "-0") fail("negative zero is forbidden")
            val value = token.toLongOrNull() ?: fail("integer overflow")
            if (value !in -CanonicalJson.SAFE_INTEGER_MAX..CanonicalJson.SAFE_INTEGER_MAX) {
                fail("integer outside JavaScript safe range")
            }
            return value
        }

        private fun expect(expected: Char) {
            if (!peek(expected)) fail("expected '$expected'")
            offset += 1
        }

        private fun peek(expected: Char): Boolean = offset < text.length && text[offset] == expected

        private fun fail(message: String): Nothing =
            throw CanonicalJsonParseError("byte/char offset $offset: $message")
    }
}

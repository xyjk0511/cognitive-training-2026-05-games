package a620

import java.nio.ByteBuffer
import java.nio.ByteOrder

object IpcFrame {
    const val HEADER_BYTES = GeneratedRuntimeProfiles.IpcFrameHeaderBytes
    const val MIN_PAYLOAD_BYTES = GeneratedRuntimeProfiles.IpcFrameMinPayloadBytes
    const val MAX_PAYLOAD_BYTES = GeneratedRuntimeProfiles.IpcFrameMaxPayloadBytes
    const val MAX_FEED_CHUNK_BYTES = GeneratedRuntimeProfiles.IpcFrameMaxFeedChunkBytes

    fun encode(value: Any?): ByteArray {
        val payload = CanonicalJson.canonicalBytes(value)
        require(payload.size in MIN_PAYLOAD_BYTES..MAX_PAYLOAD_BYTES) {
            "canonical payload size is outside A620-IPC-FRAME-1 limits"
        }
        return ByteBuffer.allocate(HEADER_BYTES + payload.size)
            .order(ByteOrder.BIG_ENDIAN)
            .putInt(payload.size)
            .put(payload)
            .array()
    }
}

class IpcFrameDecoder {
    private val header = ByteArray(IpcFrame.HEADER_BYTES)
    private var headerBytes = 0
    private var payload: ByteArray? = null
    private var payloadBytes = 0
    private var failed = false

    private fun fail(message: String): Nothing {
        failed = true
        headerBytes = 0
        payload = null
        payloadBytes = 0
        error(message)
    }

    fun feed(chunk: ByteArray): List<ByteArray> {
        check(!failed) { "frame decoder is already failed" }
        require(chunk.size <= IpcFrame.MAX_FEED_CHUNK_BYTES) {
            "frame feed chunk exceeds A620-IPC-FRAME-1 limit"
        }
        val frames = mutableListOf<ByteArray>()
        var offset = 0
        while (offset < chunk.size) {
            if (payload == null) {
                val take = minOf(IpcFrame.HEADER_BYTES - headerBytes, chunk.size - offset)
                chunk.copyInto(header, headerBytes, offset, offset + take)
                headerBytes += take
                offset += take
                if (headerBytes < IpcFrame.HEADER_BYTES) continue
                val length = ByteBuffer.wrap(header).order(ByteOrder.BIG_ENDIAN).int
                headerBytes = 0
                if (length !in IpcFrame.MIN_PAYLOAD_BYTES..IpcFrame.MAX_PAYLOAD_BYTES) {
                    fail("invalid frame payload length: $length")
                }
                payload = ByteArray(length)
                payloadBytes = 0
            }

            val current = payload!!
            val take = minOf(current.size - payloadBytes, chunk.size - offset)
            chunk.copyInto(current, payloadBytes, offset, offset + take)
            payloadBytes += take
            offset += take
            if (payloadBytes == current.size) {
                frames += current
                payload = null
                payloadBytes = 0
            }
        }
        return frames
    }

    val retainedBytes: Int
        get() = headerBytes + payloadBytes

    fun finish() {
        check(!failed) { "frame decoder is already failed" }
        if (headerBytes != 0 || payload != null || payloadBytes != 0) {
            fail("channel closed with a trailing partial frame")
        }
    }
}

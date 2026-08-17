package a620.shell

import a620.shell.generated.RuntimeShellProfiles as P

import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.security.MessageDigest
import java.util.UUID

private fun ByteArray.sha256Hex(): String =
    MessageDigest.getInstance("SHA-256").digest(this).joinToString("") { "%02x".format(it) }

enum class TransportKind { INLINE, BULK_FD }

data class BulkPayloadDescriptor(
    val payloadId: String,
    val byteLength: Int,
    val sha256: String,
    val expiresAtUptimeMs: Long,
)

data class TransportPlan(
    val kind: TransportKind,
    val canonicalSize: Int,
    val canonicalSha256: String,
    val inlineCanonical: ByteArray? = null,
    val bulk: BulkPayloadDescriptor? = null,
)

/**
 * JVM reference for the Android ParcelFileDescriptor path. The descriptor
 * contains no arbitrary filesystem path. Android must map payloadId to an
 * application-private file and duplicate the descriptor before asynchronous
 * processing.
 */
class BulkPayloadStore(private val root: Path) {
    init { Files.createDirectories(root) }

    fun stage(
        canonical: ByteArray,
        nowUptimeMs: Long,
        payloadId: String = UUID.randomUUID().toString(),
    ): BulkPayloadDescriptor {
        require(canonical.size in 1..P.BULK_CANONICAL_MAX_BYTES) {
            "bulk payload outside allowed size"
        }
        require(payloadId.matches(Regex("[A-Za-z0-9._-]{1,128}"))) { "invalid payloadId" }
        val finalPath = pathFor(payloadId)
        require(!Files.exists(finalPath)) { "payloadId already exists" }
        val tempPath = root.resolve(".$payloadId.${UUID.randomUUID()}.tmp")
        FileChannel.open(
            tempPath,
            StandardOpenOption.CREATE_NEW,
            StandardOpenOption.WRITE,
        ).use { channel ->
            var offset = 0
            while (offset < canonical.size) {
                offset += channel.write(ByteBuffer.wrap(canonical, offset, canonical.size - offset))
            }
            channel.force(true)
        }
        Files.move(tempPath, finalPath, StandardCopyOption.ATOMIC_MOVE)
        forceDirectory(root)
        return BulkPayloadDescriptor(
            payloadId = payloadId,
            byteLength = canonical.size,
            sha256 = canonical.sha256Hex(),
            expiresAtUptimeMs = nowUptimeMs + P.BULK_LEASE_MS,
        )
    }

    fun verifyAndRead(descriptor: BulkPayloadDescriptor, nowUptimeMs: Long): ByteArray {
        require(nowUptimeMs <= descriptor.expiresAtUptimeMs) { "bulk payload lease expired" }
        require(descriptor.byteLength in 1..P.BULK_CANONICAL_MAX_BYTES)
        require(descriptor.sha256.matches(Regex("[0-9a-f]{64}")))
        val path = pathFor(descriptor.payloadId)
        require(Files.isRegularFile(path)) { "bulk payload missing or not regular" }
        require(Files.size(path) == descriptor.byteLength.toLong()) { "bulk length mismatch" }
        val bytes = Files.readAllBytes(path)
        require(bytes.size == descriptor.byteLength)
        require(bytes.sha256Hex() == descriptor.sha256) { "bulk hash mismatch" }
        return bytes
    }

    fun consume(descriptor: BulkPayloadDescriptor, nowUptimeMs: Long): ByteArray {
        val bytes = verifyAndRead(descriptor, nowUptimeMs)
        Files.delete(pathFor(descriptor.payloadId))
        forceDirectory(root)
        return bytes
    }

    fun cleanupExpired(nowUptimeMs: Long, descriptors: Iterable<BulkPayloadDescriptor>) {
        descriptors.filter { nowUptimeMs > it.expiresAtUptimeMs }.forEach {
            Files.deleteIfExists(pathFor(it.payloadId))
        }
        forceDirectory(root)
    }

    private fun pathFor(payloadId: String): Path {
        require(payloadId.matches(Regex("[A-Za-z0-9._-]{1,128}"))) { "invalid payloadId" }
        val path = root.resolve("$payloadId.payload").normalize()
        require(path.parent == root.normalize()) { "payload path escaped root" }
        return path
    }

    private fun forceDirectory(path: Path) {
        try {
            FileChannel.open(path, StandardOpenOption.READ).use { it.force(true) }
        } catch (_: Exception) {
            // Some host filesystems do not allow directory fsync. Android
            // implementation must use a filesystem/API combination validated
            // on the candidate tablet.
        }
    }
}

class TransportPlanner(private val bulkStore: BulkPayloadStore) {
    fun plan(canonical: ByteArray, nowUptimeMs: Long, payloadId: String? = null): TransportPlan {
        require(canonical.isNotEmpty()) { "empty canonical message" }
        require(canonical.size <= P.BULK_CANONICAL_MAX_BYTES) { "message too large" }
        val hash = canonical.sha256Hex()
        return if (canonical.size <= P.INLINE_CANONICAL_MAX_BYTES) {
            TransportPlan(
                kind = TransportKind.INLINE,
                canonicalSize = canonical.size,
                canonicalSha256 = hash,
                inlineCanonical = canonical.copyOf(),
            )
        } else {
            val descriptor = if (payloadId == null) {
                bulkStore.stage(canonical, nowUptimeMs)
            } else {
                bulkStore.stage(canonical, nowUptimeMs, payloadId)
            }
            TransportPlan(
                kind = TransportKind.BULK_FD,
                canonicalSize = canonical.size,
                canonicalSha256 = hash,
                bulk = descriptor,
            )
        }
    }
}

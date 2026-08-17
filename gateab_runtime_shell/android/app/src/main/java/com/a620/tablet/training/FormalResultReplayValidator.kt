package com.a620.tablet.training

import a620.RuntimeWireEnvelope

/**
 * Exact replay gate for an already committed RESULT_READY.
 *
 * A stable messageId is not sufficient by itself: the complete canonical event
 * must be byte-for-byte identical to the event that created the formal result.
 * Otherwise a caller could change envelope facts that are outside
 * resultDraftSha256 and still receive the first commit ACK.
 */
internal object FormalResultReplayValidator {
    fun requireExactReplay(
        incoming: RuntimeWireEnvelope,
        incomingCanonical: ByteArray,
        persistedResultReadyMessageId: String,
        persistedResultReadyCanonical: ByteArray,
        persistedResultPayloadSha256: String,
    ) {
        if (incoming.messageType != "RESULT_READY" || incoming.senderRole != "COCOS_RUNTIME") {
            throw AndroidStoreConflict("committed result replay must be COCOS RESULT_READY")
        }
        if (incoming.messageId != persistedResultReadyMessageId) {
            throw AndroidStoreConflict("committed result replay messageId differs from first commit")
        }
        if (!incomingCanonical.contentEquals(persistedResultReadyCanonical)) {
            throw AndroidStoreConflict("same RESULT_READY messageId replayed with different canonical bytes")
        }
        val incomingHash = incoming.payload["resultDraftSha256"] as? String
            ?: throw AndroidStoreConflict("RESULT_READY.resultDraftSha256 missing")
        if (incomingHash != persistedResultPayloadSha256) {
            throw AndroidStoreConflict("committed result replay hash differs from first commit")
        }
    }
}

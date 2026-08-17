package com.a620.tablet.training;

import android.os.ParcelFileDescriptor;

oneway interface ITrainingRuntimeCallback {
    void onInlineEvent(
        String messageType,
        String messageId,
        long senderSeq,
        in byte[] canonicalJson,
        String canonicalSha256,
        String channelToken,
        long channelGeneration
    );
    void onBulkEvent(
        String messageType,
        String messageId,
        long senderSeq,
        in ParcelFileDescriptor payloadFd,
        long byteLength,
        String canonicalSha256,
        String channelToken,
        long channelGeneration
    );
    void onRuntimeInterrupted(
        String runtimeSessionId,
        long executionAttempt,
        String reason,
        long observedAtUptimeMs,
        String channelToken,
        long channelGeneration
    );
}

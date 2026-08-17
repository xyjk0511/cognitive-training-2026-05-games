package com.a620.tablet.training;

import android.os.ParcelFileDescriptor;

oneway interface ITrainingRuntimeCallback {
    void onInlineEvent(in byte[] canonicalJson, String canonicalSha256, long channelGeneration);
    void onBulkEvent(in ParcelFileDescriptor payloadFd, long byteLength, String canonicalSha256, long channelGeneration);
    void onRuntimeInterrupted(String runtimeSessionId, long executionAttempt, String reason, long observedAtUptimeMs);
}

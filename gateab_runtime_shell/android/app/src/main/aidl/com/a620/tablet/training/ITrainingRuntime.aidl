package com.a620.tablet.training;

import android.os.ParcelFileDescriptor;
import com.a620.tablet.training.ITrainingRuntimeCallback;

interface ITrainingRuntime {
    void registerCallback(ITrainingRuntimeCallback callback, long channelGeneration);

    oneway void submitInline(
        String messageType,
        String messageId,
        long senderSeq,
        in byte[] canonicalJson,
        String canonicalSha256,
        long channelGeneration
    );

    oneway void submitBulk(
        String messageType,
        String messageId,
        long senderSeq,
        in ParcelFileDescriptor payloadFd,
        long byteLength,
        String canonicalSha256,
        long channelGeneration
    );

    oneway void closeChannel(long channelGeneration, String reason);
}

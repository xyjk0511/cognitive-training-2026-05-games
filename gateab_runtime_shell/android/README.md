# Android source scaffold

This directory is an Android-shaped Gate A/B source scaffold. It intentionally
contains one launcher activity and one unexported `:training` service inside the
same application ID.

The AIDL contract keeps small canonical messages inline and carries large
payloads through `ParcelFileDescriptor`. The service duplicates incoming file
descriptors before asynchronous processing, verifies declared size and SHA-256,
and serializes all reducer ingress through a bounded one-thread actor.

The source has not been built with the Android SDK in this execution environment.
The toolchain versions in the profile are candidates, not device-approved
production locks. Required next verification:

1. Gradle wrapper generation and Android SDK compilation/lint.
2. AIDL generated-code compilation on the pinned AGP/JDK toolchain.
3. Instrumentation tests for concurrent Binder calls and transaction pressure.
4. `kill -9` of `:training` and main process with durable outcome assertions.
5. Real `MotionEvent.eventTime` boundary tests on the candidate tablet.
6. Room entities/DAOs/migrations implementing `runtime_store_v1.sql` semantics.

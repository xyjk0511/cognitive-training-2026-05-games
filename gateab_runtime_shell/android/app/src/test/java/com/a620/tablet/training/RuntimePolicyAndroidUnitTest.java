package com.a620.tablet.training;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import org.junit.Test;

public final class RuntimePolicyAndroidUnitTest {
    @Test
    public void publicWireAndPfdThresholdRemainPinned() {
        assertEquals("A620-TRC-1.1", RuntimePolicy.CONTRACT_VERSION);
        assertEquals(49_152, RuntimePolicy.INLINE_CANONICAL_MAX_BYTES);
        assertEquals(2_097_152, RuntimePolicy.BULK_CANONICAL_MAX_BYTES);
        assertFalse(RuntimePolicy.EXPOSE_RAW_AIDL_INTERFACE);
    }

    @Test
    public void onlyApprovedDataMigrationIsOneToFour() {
        assertEquals(1, GeneratedRuntimeStoreMigration.FROM_VERSION);
        assertEquals(4, GeneratedRuntimeStoreMigration.TO_VERSION);
    }
}

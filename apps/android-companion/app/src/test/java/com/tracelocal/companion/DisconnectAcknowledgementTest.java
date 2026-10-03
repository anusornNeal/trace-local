package com.tracelocal.companion;

import org.junit.Test;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.Assert.*;

public final class DisconnectAcknowledgementTest {
    @Test public void acknowledgementRunsOnceAndExecutorTerminates() throws Exception {
        ExecutorService executor = Executors.newSingleThreadExecutor();
        AtomicInteger calls = new AtomicInteger();
        DisconnectAcknowledgement.submit(executor, calls::incrementAndGet);
        assertTrue(executor.isShutdown());
        assertTrue(executor.awaitTermination(2, TimeUnit.SECONDS));
        assertEquals(1, calls.get());
    }

    @Test public void executorIsShutdownEvenWhenSubmissionFails() {
        ExecutorService executor = Executors.newSingleThreadExecutor();
        executor.shutdown();
        try {
            DisconnectAcknowledgement.submit(executor, () -> fail("Rejected task must not run"));
            fail("Expected rejection");
        } catch (java.util.concurrent.RejectedExecutionException expected) {
            assertTrue(executor.isShutdown());
        }
    }
}

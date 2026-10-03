package com.tracelocal.companion;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class DisconnectAcknowledgement {
    private DisconnectAcknowledgement() { }

    static void submit(Runnable acknowledgement) {
        submit(Executors.newSingleThreadExecutor(), acknowledgement);
    }

    static void submit(ExecutorService executor, Runnable acknowledgement) {
        try {
            executor.execute(acknowledgement);
        } finally {
            // Let the bounded HTTP request finish; no idle acknowledgement thread survives it.
            executor.shutdown();
        }
    }
}

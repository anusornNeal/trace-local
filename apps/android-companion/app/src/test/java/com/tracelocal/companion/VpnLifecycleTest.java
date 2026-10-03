package com.tracelocal.companion;

import org.junit.Test;
import static org.junit.Assert.*;

public final class VpnLifecycleTest {
    @Test public void reconnectCancellationDoesNotReusePreviousHandoff() {
        VpnLifecycle lifecycle = new VpnLifecycle();
        VpnLifecycle.ConnectionAttempt first = new VpnLifecycle.ConnectionAttempt(lifecycle.reserveConnection());
        first.markSubmitted();
        assertFalse(first.cancel(lifecycle)); // The service has been submitted but may not have started yet.
        lifecycle.startSession(first.generation);
        assertFalse(lifecycle.cancelReservation(first.generation)); // Started services survive activity destruction.
        lifecycle.finish(first.generation, "disconnected", "Disconnected");

        VpnLifecycle.ConnectionAttempt second = new VpnLifecycle.ConnectionAttempt(lifecycle.reserveConnection());
        assertTrue(second.cancel(lifecycle)); // Rotate/finish while the second HTTP request is running.
        assertFalse(lifecycle.snapshot().active);
        assertTrue(lifecycle.snapshot().canConnect(true, true));
        assertFalse(lifecycle.cancelReservation(second.generation)); // Late HTTP success only needs acknowledgement.
        assertEquals(-1, lifecycle.startSession(second.generation));
    }

    @Test public void lateCancelledRequestCannotCancelReplacementService() {
        VpnLifecycle lifecycle = new VpnLifecycle();
        long old = lifecycle.reserveConnection();
        lifecycle.cancelReservation(old);
        long next = lifecycle.startSession(0);
        assertFalse(lifecycle.cancelReservation(old));
        assertTrue(lifecycle.isCurrent(next));
        assertTrue(lifecycle.snapshot().sessionStarted);
    }

    @Test public void heartbeatRecoveryRestoresConnectedSnapshot() {
        VpnLifecycle lifecycle = new VpnLifecycle();
        long generation = lifecycle.startSession(0);
        lifecycle.update(generation, "connected", "Proxy desktop:8080");
        lifecycle.update(generation, "reconnecting", "Desktop temporarily unreachable");
        VpnLifecycle.Snapshot offline = lifecycle.snapshot();
        lifecycle.update(generation, "connected", "Proxy desktop:8080");
        assertEquals("connected", lifecycle.snapshot().state);
        assertEquals("reconnecting", offline.state); // Already published snapshots remain immutable.
        assertTrue(lifecycle.snapshot().canDisconnect());
    }

    @Test public void reopenedActivityCanDisconnectEvenAfterPairingExpires() {
        VpnLifecycle lifecycle = new VpnLifecycle();
        long generation = lifecycle.startSession(0);
        lifecycle.update(generation, "connected", "Proxy desktop:8080");
        VpnLifecycle.Snapshot restored = lifecycle.snapshot();
        assertEquals("connected", restored.state);
        assertFalse(restored.canConnect(true, true));
        assertFalse(restored.canConnect(false, false));
        assertTrue(restored.canDisconnect());
    }

    @Test public void duplicateConnectAndStartCannotReplaceActiveSession() {
        VpnLifecycle lifecycle = new VpnLifecycle();
        long reservation = lifecycle.reserveConnection();
        assertEquals(-1, lifecycle.reserveConnection());
        assertFalse(lifecycle.snapshot().canConnect(true, true));
        assertFalse(lifecycle.snapshot().canDisconnect());
        assertEquals(reservation, lifecycle.startSession(reservation));
        assertEquals(-1, lifecycle.startSession(0));
        assertEquals(reservation, lifecycle.snapshot().generation);
    }

    @Test public void terminalTeardownRejectsLateCallbacksAndIsAtMostOnce() {
        VpnLifecycle lifecycle = new VpnLifecycle();
        long old = lifecycle.startSession(0);
        assertTrue(lifecycle.finish(old, "disconnected", "Routing restored"));
        assertFalse(lifecycle.finish(old, "disconnected", "Late teardown"));
        assertFalse(lifecycle.update(old, "connected", "Late heartbeat"));
        assertEquals("Routing restored", lifecycle.snapshot().message);
        assertTrue(lifecycle.snapshot().canConnect(true, true));
        assertFalse(lifecycle.snapshot().canDisconnect());
        long next = lifecycle.startSession(0);
        assertTrue(next > old);
        assertFalse(lifecycle.update(old, "reconnecting", "Late failure"));
        assertFalse(lifecycle.finish(old, "disconnected", "Late teardown"));
        assertTrue(lifecycle.isCurrent(next));
    }

    @Test public void cancelledPermissionCannotStartLateSession() {
        VpnLifecycle lifecycle = new VpnLifecycle();
        long reservation = lifecycle.reserveConnection();
        lifecycle.finish(reservation, "error", "Permission denied");
        assertEquals(-1, lifecycle.startSession(reservation));
        assertFalse(lifecycle.snapshot().active);
        assertTrue(lifecycle.snapshot().canConnect(true, true));
        assertFalse(lifecycle.snapshot().canConnect(true, false));
        assertFalse(lifecycle.snapshot().canConnect(false, true));
    }
}

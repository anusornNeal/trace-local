package com.tracelocal.companion;

/** Process-local state; routing is owned by the service, never persisted across process death. */
final class VpnLifecycle {
    static final VpnLifecycle CURRENT = new VpnLifecycle();

    static final class ConnectionAttempt {
        final long generation;
        private boolean submitted;

        ConnectionAttempt(long generation) { this.generation = generation; }
        void markSubmitted() { submitted = true; }
        boolean cancel(VpnLifecycle lifecycle) {
            return !submitted && lifecycle.cancelReservation(generation);
        }
    }

    static final class Snapshot {
        final long generation;
        final String state;
        final String message;
        final boolean active;
        final boolean sessionStarted;

        Snapshot(long generation, String state, String message, boolean active, boolean sessionStarted) {
            this.generation = generation;
            this.state = state;
            this.message = message;
            this.active = active;
            this.sessionStarted = sessionStarted;
        }

        boolean canConnect(boolean paired, boolean trusted) { return paired && trusted && !active; }
        boolean canDisconnect() { return sessionStarted; }
    }

    private volatile Snapshot snapshot = new Snapshot(0, "idle", "", false, false);

    Snapshot snapshot() { return snapshot; }

    synchronized long reserveConnection() {
        if (snapshot.active) return -1;
        snapshot = new Snapshot(snapshot.generation + 1, "connecting", "Creating the paired device session…", true, false);
        return snapshot.generation;
    }

    synchronized long startSession(long reservation) {
        if (snapshot.sessionStarted) return -1;
        if (reservation != 0 && (!snapshot.active || snapshot.generation != reservation)) return -1;
        long generation = snapshot.active ? snapshot.generation : snapshot.generation + 1;
        snapshot = new Snapshot(generation, "connecting", "Android VPN is starting…", true, true);
        return generation;
    }

    synchronized boolean update(long generation, String state, String message) {
        if (!isCurrent(generation)) return false;
        snapshot = new Snapshot(generation, state, message, true, snapshot.sessionStarted);
        return true;
    }

    synchronized boolean finish(long generation, String state, String message) {
        if (!isCurrent(generation)) return false;
        snapshot = new Snapshot(generation, state, message, false, false);
        return true;
    }

    synchronized boolean cancelReservation(long generation) {
        if (snapshot.sessionStarted) return false;
        return finish(generation, "disconnected", "Connection cancelled");
    }

    boolean isCurrent(long generation) {
        Snapshot current = snapshot;
        return current.active && current.generation == generation;
    }
}

package com.tracelocal.companion;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.net.ProxyInfo;
import android.net.VpnService;
import android.os.Build;
import android.os.IBinder;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;

import java.io.IOException;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public final class TraceVpnService extends VpnService {
    static final String ACTION_START = "com.tracelocal.companion.START";
    static final String ACTION_STOP = "com.tracelocal.companion.STOP";
    static final String ACTION_STATE = "com.tracelocal.companion.STATE";

    static final String EXTRA_PROXY_HOST = "proxy_host";
    static final String EXTRA_PROXY_PORT = "proxy_port";
    static final String EXTRA_API_BASE_URL = "api_base_url";
    static final String EXTRA_SESSION_ID = "session_id";
    static final String EXTRA_HEARTBEAT_MS = "heartbeat_ms";
    static final String EXTRA_STALE_AFTER_MS = "stale_after_ms";
    static final String EXTRA_STATE = "state";
    static final String EXTRA_MESSAGE = "message";

    private static final int NOTIFICATION_ID = 1704;
    private static final String CHANNEL_ID = "trace_local_vpn";

    private final PairingClient client = new PairingClient();
    private ParcelFileDescriptor tunnel;
    private ScheduledExecutorService heartbeatExecutor;
    private String apiBaseUrl;
    private String sessionId;
    private long heartbeatIntervalMs = 10_000L;
    private long staleAfterMs = 45_000L;
    private volatile long lastHeartbeatSuccess;
    private volatile boolean stopping;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            stopSelf();
            return START_NOT_STICKY;
        }

        if (ACTION_STOP.equals(intent.getAction())) {
            teardown(true, "Disconnected");
            return START_NOT_STICKY;
        }

        if (!ACTION_START.equals(intent.getAction())) {
            return START_NOT_STICKY;
        }

        String host = intent.getStringExtra(EXTRA_PROXY_HOST);
        int port = intent.getIntExtra(EXTRA_PROXY_PORT, 0);
        apiBaseUrl = intent.getStringExtra(EXTRA_API_BASE_URL);
        sessionId = intent.getStringExtra(EXTRA_SESSION_ID);
        heartbeatIntervalMs = Math.max(2_000L, intent.getLongExtra(EXTRA_HEARTBEAT_MS, 10_000L));
        staleAfterMs = Math.max(heartbeatIntervalMs * 2, intent.getLongExtra(EXTRA_STALE_AFTER_MS, 45_000L));

        if (host == null || host.trim().isEmpty() || port < 1 || sessionId == null || apiBaseUrl == null) {
            broadcastState("error", "Incomplete proxy session");
            stopSelf();
            return START_NOT_STICKY;
        }

        try {
            startTunnel(host, port);
            startHeartbeat();
            return START_NOT_STICKY;
        } catch (Exception error) {
            broadcastState("error", error.getMessage() == null ? "VPN start failed" : error.getMessage());
            teardown(true, "VPN start failed");
            return START_NOT_STICKY;
        }
    }

    private void startTunnel(String host, int port) throws IOException {
        closeTunnel();

        Builder builder = new Builder()
                .setSession("Trace Local")
                .setMtu(1500)
                .addAddress("192.0.2.1", 32)
                .setBlocking(false);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            builder.setHttpProxy(ProxyInfo.buildDirectProxy(host, port));
        } else {
            throw new IOException("Trace Local requires Android 10 or newer");
        }

        tunnel = builder.establish();
        if (tunnel == null) {
            throw new IOException("Android did not establish the VPN");
        }

        createNotificationChannel();
        startForeground(NOTIFICATION_ID, buildNotification(host, port));
        lastHeartbeatSuccess = SystemClock.elapsedRealtime();
        broadcastState("connected", "Proxy " + host + ":" + port);
    }

    private void startHeartbeat() {
        if (heartbeatExecutor != null) {
            heartbeatExecutor.shutdownNow();
        }

        heartbeatExecutor = Executors.newSingleThreadScheduledExecutor();
        heartbeatExecutor.scheduleWithFixedDelay(() -> {
            if (stopping) {
                return;
            }
            try {
                PairingClient.HeartbeatResult result = client.heartbeat(apiBaseUrl, sessionId);
                lastHeartbeatSuccess = SystemClock.elapsedRealtime();
                if (result.disconnectRequested || result.restoreRouting) {
                    teardown(true, "Desktop requested disconnect");
                }
            } catch (Exception error) {
                long offlineFor = SystemClock.elapsedRealtime() - lastHeartbeatSuccess;
                if (offlineFor >= staleAfterMs) {
                    teardown(false, "Desktop unavailable; normal routing restored");
                } else {
                    broadcastState("reconnecting", "Desktop temporarily unreachable");
                }
            }
        }, heartbeatIntervalMs, heartbeatIntervalMs, TimeUnit.MILLISECONDS);
    }

    private Notification buildNotification(String host, int port) {
        Intent stopIntent = new Intent(this, TraceVpnService.class).setAction(ACTION_STOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent stopPendingIntent = PendingIntent.getService(this, 1, stopIntent, flags);

        Notification.Action stopAction = new Notification.Action.Builder(
                android.R.drawable.ic_menu_close_clear_cancel,
                "Disconnect",
                stopPendingIntent
        ).build();

        return new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_upload_done)
                .setContentTitle("Trace Local connected")
                .setContentText("HTTP/HTTPS proxy: " + host + ":" + port)
                .setOngoing(true)
                .setCategory(Notification.CATEGORY_SERVICE)
                .addAction(stopAction)
                .build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Trace Local connection",
                    NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Shows the active Trace Local proxy session");
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
    }

    private synchronized void teardown(boolean acknowledgeDesktop, String message) {
        if (stopping) {
            return;
        }
        stopping = true;

        if (heartbeatExecutor != null) {
            heartbeatExecutor.shutdownNow();
            heartbeatExecutor = null;
        }

        closeTunnel();

        if (acknowledgeDesktop && apiBaseUrl != null && sessionId != null) {
            Executors.newSingleThreadExecutor().execute(() ->
                    client.acknowledgeDisconnected(apiBaseUrl, sessionId)
            );
        }

        stopForeground(STOP_FOREGROUND_REMOVE);
        broadcastState("disconnected", message);
        stopSelf();
    }

    private void closeTunnel() {
        if (tunnel != null) {
            try {
                tunnel.close();
            } catch (IOException ignored) {
            }
            tunnel = null;
        }
    }

    private void broadcastState(String state, String message) {
        Intent intent = new Intent(ACTION_STATE)
                .setPackage(getPackageName())
                .putExtra(EXTRA_STATE, state)
                .putExtra(EXTRA_MESSAGE, message);
        sendBroadcast(intent);
    }

    @Override
    public void onRevoke() {
        teardown(true, "VPN permission revoked");
        super.onRevoke();
    }

    @Override
    public void onDestroy() {
        if (!stopping) {
            stopping = true;
            if (heartbeatExecutor != null) {
                heartbeatExecutor.shutdownNow();
                heartbeatExecutor = null;
            }
            closeTunnel();
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return super.onBind(intent);
    }
}

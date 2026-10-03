package com.tracelocal.companion;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

final class PairingClient {
    private static final int CONNECT_TIMEOUT_MS = 6_000;
    private static final int READ_TIMEOUT_MS = 8_000;

    PairingContract redeemPairing(String pairingUrl) throws Exception {
        HttpResult result = request("GET", pairingUrl, null);
        ensureSuccess(result, "Pairing failed");
        return PairingContract.fromJson(result.text());
    }

    SessionConfig connect(PairingContract pairing, String deviceId, String name) throws Exception {
        JSONObject body = new JSONObject()
                .put("pairingId", pairing.pairingId)
                .put("deviceId", deviceId)
                .put("name", name)
                .put("platform", "android");
        HttpResult result = request("POST", pairing.apiBaseUrl + "/device/session", body.toString());
        ensureSuccess(result, "Device connection failed");

        JSONObject payload = new JSONObject(result.text());
        JSONObject session = payload.getJSONObject("session");
        return new SessionConfig(
                session.getString("sessionId"),
                payload.optLong("heartbeatIntervalMs", 10_000L),
                payload.optLong("staleAfterMs", 45_000L),
                payload.optBoolean("restoreRoutingOnDisconnect", true)
        );
    }

    HeartbeatResult heartbeat(String apiBaseUrl, String sessionId) throws Exception {
        HttpResult result = request(
                "POST",
                apiBaseUrl + "/device/session/" + urlSegment(sessionId) + "/heartbeat",
                "{}"
        );

        if (result.statusCode == 404) {
            return new HeartbeatResult(true, true);
        }
        ensureSuccess(result, "Heartbeat failed");
        JSONObject payload = new JSONObject(result.text());
        return new HeartbeatResult(
                payload.optBoolean("disconnectRequested", false),
                payload.optBoolean("restoreRouting", false)
        );
    }

    void acknowledgeDisconnected(String apiBaseUrl, String sessionId) {
        try {
            request(
                    "POST",
                    apiBaseUrl + "/device/session/" + urlSegment(sessionId) + "/disconnected",
                    "{}"
            );
        } catch (Exception ignored) {
            // Best effort: local routing teardown must never depend on the desktop being reachable.
        }
    }

    byte[] downloadCa(PairingContract pairing) throws Exception {
        HttpResult result = request("GET", pairing.caDownloadUrl, null);
        ensureSuccess(result, "CA download failed");
        return result.body;
    }

    private static void ensureSuccess(HttpResult result, String prefix) throws IOException {
        if (result.statusCode < 200 || result.statusCode >= 300) {
            String details = result.text().trim().isEmpty() ? ("HTTP " + result.statusCode) : result.text();
            throw new IOException(prefix + ": " + details);
        }
    }

    private static HttpResult request(String method, String value, String jsonBody) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(value).openConnection(java.net.Proxy.NO_PROXY);
        connection.setRequestMethod(method);
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setUseCaches(false);
        connection.setRequestProperty("Accept", "application/json");

        if (jsonBody != null) {
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            byte[] bytes = jsonBody.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(bytes);
            }
        }

        int status = connection.getResponseCode();
        InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        byte[] body = stream == null ? new byte[0] : readFully(stream);
        connection.disconnect();
        return new HttpResult(status, body);
    }

    private static byte[] readFully(InputStream input) throws IOException {
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8 * 1024];
            int read;
            while ((read = stream.read(buffer)) >= 0) {
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        }
    }

    private static String urlSegment(String value) {
        return java.net.URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
    }

    static final class SessionConfig {
        final String sessionId;
        final long heartbeatIntervalMs;
        final long staleAfterMs;
        final boolean restoreRoutingOnDisconnect;

        SessionConfig(String sessionId, long heartbeatIntervalMs, long staleAfterMs, boolean restoreRoutingOnDisconnect) {
            this.sessionId = sessionId;
            this.heartbeatIntervalMs = heartbeatIntervalMs;
            this.staleAfterMs = staleAfterMs;
            this.restoreRoutingOnDisconnect = restoreRoutingOnDisconnect;
        }
    }

    static final class HeartbeatResult {
        final boolean disconnectRequested;
        final boolean restoreRouting;

        HeartbeatResult(boolean disconnectRequested, boolean restoreRouting) {
            this.disconnectRequested = disconnectRequested;
            this.restoreRouting = restoreRouting;
        }
    }

    private static final class HttpResult {
        final int statusCode;
        final byte[] body;

        HttpResult(int statusCode, byte[] body) {
            this.statusCode = statusCode;
            this.body = body;
        }

        String text() {
            return new String(body, StandardCharsets.UTF_8);
        }
    }
}

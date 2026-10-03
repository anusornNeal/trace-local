package com.tracelocal.companion;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Locale;

final class PairingContract {
    static final int PROTOCOL_VERSION = 1;

    final String pairingId;
    final String desktopId;
    final String proxyHost;
    final int proxyPort;
    final String caFingerprint256;
    final String apiBaseUrl;
    final String caDownloadUrl;
    final long expiresAt;

    PairingContract(
            String pairingId,
            String desktopId,
            String proxyHost,
            int proxyPort,
            String caFingerprint256,
            String apiBaseUrl,
            String caDownloadUrl,
            long expiresAt
    ) {
        this.pairingId = pairingId;
        this.desktopId = desktopId;
        this.proxyHost = proxyHost;
        this.proxyPort = proxyPort;
        this.caFingerprint256 = normalizeFingerprint(caFingerprint256);
        this.apiBaseUrl = trimTrailingSlash(apiBaseUrl);
        this.caDownloadUrl = caDownloadUrl;
        this.expiresAt = expiresAt;
    }

    static PairingContract fromJson(String json) throws JSONException {
        JSONObject object = new JSONObject(json);
        int version = object.getInt("protocolVersion");
        if (version != PROTOCOL_VERSION) {
            throw new JSONException("Unsupported pairing protocol: " + version);
        }

        HostPort proxy = parseHostPort(object.getString("proxyAddress"));
        return new PairingContract(
                object.getString("pairingId"),
                object.getString("desktopId"),
                proxy.host,
                proxy.port,
                object.getString("caFingerprint256"),
                object.getString("apiBaseUrl"),
                object.getString("caDownloadUrl"),
                object.getLong("expiresAt")
        );
    }

    boolean isExpired(long nowMs) {
        return nowMs >= expiresAt;
    }

    static String normalizeFingerprint(String value) {
        return value == null ? "" : value.replaceAll("[^0-9A-Fa-f]", "").toUpperCase(Locale.US);
    }

    static HostPort parseHostPort(String value) {
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalArgumentException("Proxy address is empty");
        }

        final String host;
        final String portText;
        if (value.startsWith("[")) {
            int close = value.indexOf(']');
            if (close < 0 || close + 2 > value.length() || value.charAt(close + 1) != ':') {
                throw new IllegalArgumentException("Invalid IPv6 proxy address");
            }
            host = value.substring(1, close);
            portText = value.substring(close + 2);
        } else {
            int separator = value.lastIndexOf(':');
            if (separator <= 0 || separator == value.length() - 1) {
                throw new IllegalArgumentException("Invalid proxy address");
            }
            host = value.substring(0, separator);
            portText = value.substring(separator + 1);
        }

        int port = Integer.parseInt(portText);
        if (port < 1 || port > 65535) {
            throw new IllegalArgumentException("Invalid proxy port");
        }
        return new HostPort(host, port);
    }

    private static String trimTrailingSlash(String value) {
        String result = value == null ? "" : value.trim();
        while (result.endsWith("/")) {
            result = result.substring(0, result.length() - 1);
        }
        return result;
    }

    static final class HostPort {
        final String host;
        final int port;

        HostPort(String host, int port) {
            this.host = host;
            this.port = port;
        }
    }
}

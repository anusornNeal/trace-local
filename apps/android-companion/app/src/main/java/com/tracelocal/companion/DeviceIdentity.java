package com.tracelocal.companion;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;

import java.util.UUID;

final class DeviceIdentity {
    private static final String PREFS = "trace_local_companion";
    private static final String DEVICE_ID = "device_id";
    private static final String TRUSTED_CA = "trusted_ca_fingerprint";

    private final SharedPreferences preferences;

    DeviceIdentity(Context context) {
        preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    String deviceId() {
        String existing = preferences.getString(DEVICE_ID, null);
        if (existing != null && !existing.trim().isEmpty()) {
            return existing;
        }
        String created = UUID.randomUUID().toString();
        preferences.edit().putString(DEVICE_ID, created).apply();
        return created;
    }

    String displayName() {
        String manufacturer = Build.MANUFACTURER == null ? "Android" : Build.MANUFACTURER.trim();
        String model = Build.MODEL == null ? "Device" : Build.MODEL.trim();
        if (manufacturer.trim().isEmpty()) {
            manufacturer = "Android";
        }
        if (model.toLowerCase().startsWith(manufacturer.toLowerCase())) {
            return model;
        }
        return manufacturer + " " + model;
    }

    boolean trustsFingerprint(String fingerprint) {
        String trusted = preferences.getString(TRUSTED_CA, "");
        return PairingContract.normalizeFingerprint(trusted)
                .equals(PairingContract.normalizeFingerprint(fingerprint));
    }

    void markFingerprintTrusted(String fingerprint) {
        preferences.edit()
                .putString(TRUSTED_CA, PairingContract.normalizeFingerprint(fingerprint))
                .apply();
    }

    void savePairing(PairingContract pairing) {
        preferences.edit()
                .putString("pairing_id", pairing.pairingId)
                .putString("desktop_id", pairing.desktopId)
                .putString("proxy_host", pairing.proxyHost)
                .putInt("proxy_port", pairing.proxyPort)
                .putString("ca_fingerprint", pairing.caFingerprint256)
                .putString("api_base_url", pairing.apiBaseUrl)
                .putString("ca_download_url", pairing.caDownloadUrl)
                .putLong("pairing_expires_at", pairing.expiresAt)
                .apply();
    }

    PairingContract loadPairing() {
        String pairingId = preferences.getString("pairing_id", "");
        if (pairingId == null || pairingId.trim().isEmpty()) {
            return null;
        }
        return new PairingContract(
                pairingId,
                preferences.getString("desktop_id", ""),
                preferences.getString("proxy_host", ""),
                preferences.getInt("proxy_port", 0),
                preferences.getString("ca_fingerprint", ""),
                preferences.getString("api_base_url", ""),
                preferences.getString("ca_download_url", ""),
                preferences.getLong("pairing_expires_at", 0)
        );
    }

    void clearPairing() {
        preferences.edit()
                .remove("pairing_id")
                .remove("desktop_id")
                .remove("proxy_host")
                .remove("proxy_port")
                .remove("ca_fingerprint")
                .remove("api_base_url")
                .remove("ca_download_url")
                .remove("pairing_expires_at")
                .apply();
    }
}

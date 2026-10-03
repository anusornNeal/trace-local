package com.tracelocal.companion;

import android.app.Activity;
import android.app.KeyguardManager;
import android.net.VpnService;
import android.os.Build;
import android.os.Bundle;
import android.security.KeyChain;
import android.content.BroadcastReceiver;
import android.content.ClipboardManager;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanner;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final int REQUEST_CA_INSTALL = 41;
    private static final int REQUEST_VPN = 42;

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final PairingClient client = new PairingClient();

    private DeviceIdentity identity;
    private PairingContract pairing;

    private TextView statusText;
    private TextView detailText;
    private Button scanButton;
    private Button installCaButton;
    private Button connectButton;
    private Button disconnectButton;

    private final BroadcastReceiver vpnStateReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String state = intent.getStringExtra(TraceVpnService.EXTRA_STATE);
            String message = intent.getStringExtra(TraceVpnService.EXTRA_MESSAGE);
            if (state != null) {
                setStatus(prettyState(state), message == null ? "" : message);
                disconnectButton.setEnabled(!"disconnected".equals(state));
            }
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        identity = new DeviceIdentity(this);
        pairing = identity.loadPairing();
        if (pairing != null && pairing.isExpired(System.currentTimeMillis())) {
            identity.clearPairing();
            pairing = null;
        }

        setContentView(buildContent());
        handleIntent(getIntent());
        renderPairing();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    @Override
    protected void onStart() {
        super.onStart();
        IntentFilter filter = new IntentFilter(TraceVpnService.ACTION_STATE);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(vpnStateReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(vpnStateReceiver, filter);
        }
    }

    @Override
    protected void onStop() {
        unregisterReceiver(vpnStateReceiver);
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        executor.shutdownNow();
        super.onDestroy();
    }

    private View buildContent() {
        int padding = dp(20);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(padding, padding, padding, padding);
        root.setBackgroundColor(Color.rgb(248, 250, 252));

        TextView title = new TextView(this);
        title.setText("Trace Local");
        title.setTextSize(26);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        title.setTextColor(Color.rgb(15, 23, 42));
        root.addView(title);

        TextView subtitle = new TextView(this);
        subtitle.setText("Scan the pairing QR shown by the desktop app.");
        subtitle.setTextSize(14);
        subtitle.setTextColor(Color.rgb(71, 85, 105));
        subtitle.setPadding(0, dp(4), 0, dp(18));
        root.addView(subtitle);

        statusText = new TextView(this);
        statusText.setTextSize(18);
        statusText.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        statusText.setTextColor(Color.rgb(15, 23, 42));
        root.addView(statusText);

        detailText = new TextView(this);
        detailText.setTextSize(13);
        detailText.setTextColor(Color.rgb(71, 85, 105));
        detailText.setPadding(0, dp(6), 0, dp(18));
        root.addView(detailText);

        scanButton = actionButton("Scan pairing QR");
        scanButton.setOnClickListener(v -> scanPairingQr());
        root.addView(scanButton);

        Button pasteButton = secondaryButton("Use link from clipboard");
        pasteButton.setOnClickListener(v -> useClipboardLink());
        root.addView(pasteButton);

        installCaButton = secondaryButton("Install Trace Local CA");
        installCaButton.setOnClickListener(v -> installCa());
        root.addView(installCaButton);

        connectButton = actionButton("Connect");
        connectButton.setOnClickListener(v -> connect());
        root.addView(connectButton);

        disconnectButton = secondaryButton("Disconnect");
        disconnectButton.setOnClickListener(v -> disconnect());
        root.addView(disconnectButton);

        TextView limitation = new TextView(this);
        limitation.setText("Android exposes the VPN HTTP proxy as a system recommendation. Proxy-aware HTTP/HTTPS clients use Trace Local; apps that explicitly ignore the platform proxy are not forced through it.");
        limitation.setTextSize(12);
        limitation.setTextColor(Color.rgb(100, 116, 139));
        limitation.setPadding(0, dp(18), 0, 0);
        root.addView(limitation);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(root);
        return scroll;
    }

    private Button actionButton(String text) {
        Button button = new Button(this);
        button.setText(text);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        );
        params.setMargins(0, dp(6), 0, dp(6));
        button.setLayoutParams(params);
        return button;
    }

    private Button secondaryButton(String text) {
        return actionButton(text);
    }

    private void scanPairingQr() {
        GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .enableAutoZoom()
                .build();
        GmsBarcodeScanner scanner = GmsBarcodeScanning.getClient(this, options);

        setStatus("Scanning", "Point the camera at the Trace Local pairing QR.");
        scanner.startScan()
                .addOnSuccessListener(barcode -> {
                    String value = barcode.getRawValue();
                    if (value == null || value.trim().isEmpty()) {
                        setStatus("Scan failed", "The QR code did not contain a pairing link.");
                        return;
                    }
                    redeemPairing(value);
                })
                .addOnCanceledListener(() -> renderPairing())
                .addOnFailureListener(error -> setStatus("Scan failed", error.getMessage()));
    }

    private void useClipboardLink() {
        ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        if (clipboard == null || !clipboard.hasPrimaryClip()) {
            setStatus("No pairing link", "Clipboard is empty.");
            return;
        }
        ClipData clip = clipboard.getPrimaryClip();
        if (clip == null || clip.getItemCount() == 0) {
            setStatus("No pairing link", "Clipboard is empty.");
            return;
        }
        CharSequence text = clip.getItemAt(0).coerceToText(this);
        redeemPairing(text == null ? "" : text.toString().trim());
    }

    private void handleIntent(Intent intent) {
        if (intent == null || intent.getData() == null) {
            return;
        }
        Uri data = intent.getData();
        if ("tracelocal".equalsIgnoreCase(data.getScheme()) && "pair".equalsIgnoreCase(data.getHost())) {
            String url = data.getQueryParameter("url");
            if (url != null) {
                redeemPairing(url);
            }
        }
    }

    private void redeemPairing(String url) {
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            setStatus("Invalid pairing link", "Expected the LAN pairing URL from Trace Local.");
            return;
        }

        setStatus("Pairing", "Contacting desktop…");
        setActionsEnabled(false);
        executor.execute(() -> {
            try {
                PairingContract result = client.redeemPairing(url);
                if (result.isExpired(System.currentTimeMillis())) {
                    throw new IllegalStateException("Pairing authorization expired. Generate a new QR.");
                }
                identity.savePairing(result);
                pairing = result;
                runOnUiThread(() -> {
                    setActionsEnabled(true);
                    renderPairing();
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    setActionsEnabled(true);
                    setStatus("Pairing failed", message(error));
                });
            }
        });
    }

    private void installCa() {
        if (pairing == null) {
            setStatus("Scan first", "Scan a fresh pairing QR before installing the CA.");
            return;
        }

        setStatus("Preparing CA", "Downloading the public Trace Local certificate…");
        installCaButton.setEnabled(false);
        executor.execute(() -> {
            try {
                byte[] certificate = client.downloadCa(pairing);
                Intent installIntent = KeyChain.createInstallIntent();
                installIntent.putExtra(KeyChain.EXTRA_CERTIFICATE, certificate);
                installIntent.putExtra(KeyChain.EXTRA_NAME, "Trace Local CA");
                runOnUiThread(() -> {
                    installCaButton.setEnabled(true);
                    startActivityForResult(installIntent, REQUEST_CA_INSTALL);
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    installCaButton.setEnabled(true);
                    setStatus("CA download failed", message(error));
                });
            }
        });
    }

    private void connect() {
        if (pairing == null) {
            setStatus("Scan first", "Scan a fresh pairing QR before connecting.");
            return;
        }
        if (pairing.isExpired(System.currentTimeMillis())) {
            identity.clearPairing();
            pairing = null;
            renderPairing();
            setStatus("Pairing expired", "Generate and scan a new QR.");
            return;
        }
        if (!identity.trustsFingerprint(pairing.caFingerprint256)) {
            setStatus("CA required", "Install and trust the Trace Local CA first.");
            return;
        }

        Intent permission = VpnService.prepare(this);
        if (permission != null) {
            startActivityForResult(permission, REQUEST_VPN);
        } else {
            createSessionAndStartVpn();
        }
    }

    private void createSessionAndStartVpn() {
        if (pairing == null) {
            return;
        }

        setStatus("Connecting", "Creating the paired device session…");
        connectButton.setEnabled(false);
        executor.execute(() -> {
            try {
                PairingClient.SessionConfig session = client.connect(
                        pairing,
                        identity.deviceId(),
                        identity.displayName()
                );
                runOnUiThread(() -> {
                    connectButton.setEnabled(true);
                    startVpn(session);
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    connectButton.setEnabled(true);
                    setStatus("Connection failed", message(error));
                });
            }
        });
    }

    private void startVpn(PairingClient.SessionConfig session) {
        Intent service = new Intent(this, TraceVpnService.class)
                .setAction(TraceVpnService.ACTION_START)
                .putExtra(TraceVpnService.EXTRA_PROXY_HOST, pairing.proxyHost)
                .putExtra(TraceVpnService.EXTRA_PROXY_PORT, pairing.proxyPort)
                .putExtra(TraceVpnService.EXTRA_API_BASE_URL, pairing.apiBaseUrl)
                .putExtra(TraceVpnService.EXTRA_SESSION_ID, session.sessionId)
                .putExtra(TraceVpnService.EXTRA_HEARTBEAT_MS, session.heartbeatIntervalMs)
                .putExtra(TraceVpnService.EXTRA_STALE_AFTER_MS, session.staleAfterMs);
        startForegroundService(service);
        setStatus("Connecting", "Android VPN is starting…");
    }

    private void disconnect() {
        Intent service = new Intent(this, TraceVpnService.class).setAction(TraceVpnService.ACTION_STOP);
        startService(service);
        setStatus("Disconnecting", "Restoring normal routing…");
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);

        if (requestCode == REQUEST_CA_INSTALL) {
            if (resultCode == RESULT_OK && pairing != null) {
                identity.markFingerprintTrusted(pairing.caFingerprint256);
                setStatus("CA ready", "Certificate installer completed. You can connect.");
            } else {
                setStatus("CA not confirmed", "Complete the Android certificate installation before connecting.");
            }
            renderPairing();
            return;
        }

        if (requestCode == REQUEST_VPN) {
            if (resultCode == RESULT_OK) {
                createSessionAndStartVpn();
            } else {
                setStatus("VPN permission required", "Android VPN permission is required to expose the proxy connection.");
            }
        }
    }

    private void renderPairing() {
        boolean paired = pairing != null && !pairing.isExpired(System.currentTimeMillis());
        boolean caReady = paired && identity.trustsFingerprint(pairing.caFingerprint256);

        installCaButton.setEnabled(paired && !caReady);
        connectButton.setEnabled(paired && caReady);
        disconnectButton.setEnabled(true);

        if (!paired) {
            setStatus("Ready to pair", "Open Trace Local on the desktop and scan its pairing QR.");
        } else if (!caReady) {
            setStatus("Certificate required", "Paired with " + pairing.desktopId + ". Install the CA before connecting.");
        } else {
            setStatus("Ready to connect", "Paired with " + pairing.desktopId + " at " + pairing.proxyHost + ":" + pairing.proxyPort + ".");
        }
    }

    private void setActionsEnabled(boolean enabled) {
        scanButton.setEnabled(enabled);
        installCaButton.setEnabled(enabled && pairing != null);
        connectButton.setEnabled(enabled && pairing != null);
    }

    private void setStatus(String status, String detail) {
        statusText.setText(status == null ? "" : status);
        detailText.setText(detail == null ? "" : detail);
    }

    private static String prettyState(String state) {
        if (state == null || state.trim().isEmpty()) {
            return "Trace Local";
        }
        return Character.toUpperCase(state.charAt(0)) + state.substring(1);
    }

    private static String message(Throwable error) {
        String message = error.getMessage();
        return message == null || message.trim().isEmpty() ? error.getClass().getSimpleName() : message;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}

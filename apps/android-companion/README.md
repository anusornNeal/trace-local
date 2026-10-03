# Trace Local Android Companion

Native Android companion for the Trace Local desktop proxy.

## Normal flow

First use:

1. Open **Pair mobile device** in Trace Local desktop.
2. Scan the QR in this app.
3. Install the public Trace Local CA when prompted.
4. Approve Android VPN permission.
5. Tap **Connect**.

Returning use:

1. Scan a fresh pairing QR.
2. Tap **Connect**.

No ADB command or manual Wi-Fi proxy edit is required for the normal flow.

## Connection model

The companion redeems the desktop's single-use pairing URL, creates a paired device session, and starts an Android `VpnService`. On Android 10+ it exposes the desktop proxy through `VpnService.Builder.setHttpProxy`.

The Android platform documents this HTTP proxy as a recommendation. Proxy-aware HTTP/HTTPS clients use it, while an app that deliberately ignores the platform proxy is not forced through Trace Local. This companion therefore does not claim transparent raw-IP TUN forwarding.

While connected the service:

- sends heartbeats directly to the desktop without using the configured HTTP proxy;
- obeys desktop GUI/CLI disconnect requests;
- tears down the VPN when the desktop remains unreachable past the advertised stale timeout;
- always closes the VPN interface before stopping, restoring normal device routing.

## Certificate trust

The desktop returns a short-lived public CA download URL after the QR is redeemed. Android's system certificate installer is used; the private CA key never leaves the desktop.

The app remembers the CA fingerprint after a successful certificate-installer result so subsequent pairings with the same CA can skip the installer step. Android and individual apps may apply additional certificate-trust policies; HTTPS interception must be validated against the actual target app.

## Build

Requirements:

- JDK 17+
- Android SDK with API 35

On Windows:

```powershell
.\gradlew.bat testDebugUnitTest assembleDebug
```

Debug APK:

```text
app/build/outputs/apk/debug/app-debug.apk
```

## Verification still requiring a physical Android device

The repository build verifies Java compilation, unit tests, manifest packaging, and APK assembly. Release acceptance still requires physical-device E2E for QR camera scanning, system CA installation, VPN permission, captured HTTP/HTTPS traffic, GUI/CLI disconnect, Wi-Fi changes, process loss, and reconnect/cleanup behavior.

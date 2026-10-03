# Trace Local iOS Companion

Native iOS companion for the Trace Local desktop proxy.

## User flow

First use:

1. Open **Pair mobile device** on Trace Local desktop.
2. Scan the short-lived QR in the iOS app.
3. Download/install the Trace Local CA and enable full trust under **Settings > General > About > Certificate Trust Settings**.
4. Confirm the certificate step in the app.
5. Tap **Connect** and approve the iOS VPN configuration prompt.

Returning use with the same trusted CA:

1. Scan a fresh pairing QR.
2. Tap **Connect**.

No manual Wi-Fi proxy edit is part of the normal flow.

## Network Extension behavior

The Packet Tunnel extension configures `NEProxySettings` for the desktop HTTP/HTTPS proxy and deliberately does **not** install a default packet route. This avoids blackholing traffic because Trace Local does not yet include a raw IP packet forwarder. Apps/connections that bypass the system proxy are therefore not transparently intercepted.

The extension sends heartbeats directly to the desktop, obeys desktop disconnect requests, and cancels the tunnel when the desktop remains unreachable past the advertised stale timeout. Stopping the extension removes its proxy/tunnel settings and restores normal routing.

## Certificate behavior

The QR itself contains only a single-use LAN pairing URL. After redemption the desktop returns a short-lived public CA download URL. The iOS app opens that URL for the system installation flow; CA full-trust remains an explicit user action required by iOS. The private CA key never leaves the desktop.

The app stores only the trusted CA fingerprint marker and a persistent random device ID. A new fingerprint requires the certificate/trust flow again.

## Build requirements

- macOS with Xcode 15+
- iOS 17+
- Apple Developer account with Network Extension entitlement approval
- Signing/provisioning for both app and packet-tunnel extension

Open `TraceLocal.xcodeproj`, select your development team for both targets, then build the `TraceLocal` scheme.

## Windows validation boundary

This repository can author and statically inspect the project on Windows, but Windows cannot run Xcode, Swift compilation, iOS Simulator, entitlement signing, or a physical iPhone E2E. Those are release-validation requirements, not silently treated as passed.

Physical iPhone verification must cover QR camera scanning, CA installation/full trust, VPN permission, captured HTTP/HTTPS traffic for proxy-aware clients, desktop GUI/CLI disconnect, desktop crash/loss cleanup, network changes, and returning-user reconnect.

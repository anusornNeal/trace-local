# Trace Local

Local-first HTTP/HTTPS traffic inspector and Map Local proxy for Windows and macOS. It includes a CLI, an embedded local CA for HTTPS interception, persistent Map Local rules, HAR export, live SSE updates, and an Electron desktop inspector.

## Quick start

```bash
npm install
npm run desktop
```

The desktop app prefers the stable loopback proxy address `http://127.0.0.1:8888`, matching the CLI default. If port 8888 is already occupied, it falls back to a free loopback port; the address shown in the header or **Settings** is always authoritative.

For CLI-only development:

```bash
npm run dev:daemon
npm run dev:cli -- --help
```

## Mobile companions

For Android and iPhone, the intended product flow is:

1. Open **Settings → Mobile companions** in Trace Local desktop.
2. Click **Pair mobile device** and scan the short-lived QR in the companion app.
3. On first use, install/trust the Trace Local CA using the OS flow and approve the VPN configuration.
4. Tap **Connect**. Returning devices using the same trusted CA normally scan a fresh QR and connect without editing Wi-Fi proxy settings.
5. Disconnect from the companion, desktop UI, or CLI. If the desktop disappears, the companion removes its VPN/proxy configuration after the bounded stale timeout so normal routing is restored.

Normal mobile use does not require editing Wi-Fi proxy settings.

The QR is single-use and carries only a short-lived LAN pairing reference. The CA private key never leaves the desktop.

Android uses the platform VPN HTTP proxy for proxy-aware HTTP/HTTPS traffic. iOS configures HTTP/HTTPS proxy settings inside its Network Extension without installing a default packet route. Apps that deliberately bypass the platform proxy are outside the current transparent-interception scope.

### Mobile release-candidate validation

Run the checks supported on the current machine:

```bash
npm run verify:mobile
```

A release candidate is not considered physically validated until the platform matrix is executed on real hardware:

| Scenario | Windows automation | Physical Android | macOS + physical iPhone |
| --- | --- | --- | --- |
| Pairing contract / expiry / multi-device lifecycle | Automated | Confirm | Confirm |
| First-use CA + VPN flow | Source/build checks | Required | Required |
| Returning-user QR connect | Contract checks | Required | Required |
| Desktop GUI / CLI disconnect | Automated server/CLI | Required | Required |
| Graceful shutdown / desktop loss cleanup | Automated server lifecycle | Required | Required |
| Sleep/wake, Wi-Fi/LAN/IP change | Not simulated | Required | Required |
| HTTPS capture for target apps | Proxy regression tests | Required | Required |
| iOS Xcode compile, signing, entitlement | Not available on Windows | — | Required |

The matrix intentionally distinguishes implementation checks from hardware/signing verification; unavailable platform checks are never reported as passed.

## Advanced/manual client configuration

1. Open **Settings** and copy the proxy address.
2. Configure the development browser, emulator, device, or app you control to use that HTTP/HTTPS proxy.
3. For HTTPS inspection, import the CA certificate path shown in **Settings** into that development client.
4. Remove the CA trust when you no longer need interception.

Trace Local does not install trust certificates automatically and binds its control surface to loopback by default.

## Map Local

Open **Map Local**, create a rule, choose a local response file, then match by full URL, host, or path. Rules are persisted locally and can be enabled, disabled, or removed without restarting the proxy.

If persisted Map Local state becomes invalid or belongs to an unsupported format, Trace Local moves the original `rules.json` aside as a timestamped `rules.rejected-*.json` backup and starts with an empty rule set. The desktop UI shows a startup warning with the preserved backup path. Filesystem and permission failures are not treated as recoverable corruption.

## Verification

```bash
npm test
npm run typecheck
npm run build
npm run audit:prod
npm run e2e:desktop
```

`e2e:desktop` launches the real Electron entry with temporary ports, Trace Local data, and Electron user data. It sends real proxy traffic, verifies capture and Map Local behavior, then checks that the proxy/control ports are released without touching normal user state.

The production audit is expected to report no high-severity vulnerabilities. The project pins `basic-ftp` 6.2.1 through an npm override because Mockttp's proxy dependency chain otherwise resolves an affected 5.x release.

## Stress and performance

```bash
npm run stress
```

The default stress scenario sends 2,000 real proxied HTTP requests with concurrency 32, verifies the configured session cap, imports 150 Map Local rules, exercises mapped traffic, and reports throughput, p50/p95/p99 latency, rule-install time, and process memory deltas. It uses isolated temporary state and a deliberately broad 256 MiB RSS safety budget; it is a regression/stability guard rather than a microbenchmark.

The load can be adjusted with `TRACELOCAL_STRESS_REQUESTS`, `TRACELOCAL_STRESS_CONCURRENCY`, `TRACELOCAL_STRESS_MAX_SESSIONS`, `TRACELOCAL_STRESS_RULES`, and `TRACELOCAL_STRESS_MAPPED_REQUESTS`.

## Desktop packaging

Create an unpacked app for the current platform:

```bash
npm run package:dir
npm run package:smoke
```

Windows installer:

```bash
npm run package:win
```

macOS DMG and ZIP (run on macOS):

```bash
npm run package:mac
```

Local builds are intentionally unsigned unless signing credentials are supplied by the release environment. Do not commit signing certificates or credentials.

## Release verification CI

GitHub Actions runs the production audit, tests, typecheck, build, unpacked packaging, and package smoke on both Windows and macOS for pull requests and pushes to `main`. The workflow uploads short-lived unsigned verification artifacts for inspection.

CI artifacts are not trusted production installers. Code signing, Apple notarization, branded application icons, and final platform release validation belong to the release environment and require the corresponding credentials/assets.

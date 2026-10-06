# Trace Local

Local-first HTTP/HTTPS traffic inspector and Map Local proxy for Windows and macOS. It includes a CLI, an embedded local CA for HTTPS interception, persistent Map Local rules, HAR export, live SSE updates, and an Electron desktop inspector.

## Quick start

```bash
npm install
npm run desktop
```

The desktop app uses proxy port 8888, matching the CLI default, and advertises its LAN address for mobile connections. If the port is occupied, startup explains the conflict; close the conflicting app or set `TRACELOCAL_PROXY_PORT` to another port. The address shown in the header or **Settings** is authoritative.

For CLI-only development:

```bash
npm run dev:daemon
npm run dev:cli -- --help
```

## Mobile setup (no mobile app)

Trace Local follows the same basic mobile setup model as desktop debugging proxies such as Proxyman: the phone connects to the desktop proxy manually, and HTTPS interception requires manually installing the Trace Local CA.

1. Open **Settings → Mobile setup** in Trace Local desktop.
2. On the phone, edit the current Wi-Fi network and set its HTTP proxy to **Manual**.
3. Enter the LAN host and port shown by Trace Local (default proxy port: `8888`).
4. For HTTPS inspection, click **Show CA download QR** in Trace Local and scan it with the phone.
5. Download and install/trust the CA using the operating-system certificate flow.
6. Remove the Wi-Fi proxy and CA trust when debugging is finished.

The QR code is only a convenience for opening a short-lived CA download URL on the phone. It does **not** pair a device, install a mobile app, change Wi-Fi proxy settings, install the certificate, or grant certificate trust automatically.

No Trace Local Android or iOS companion app is required.

### Mobile verification

Run the automated contract checks:

```bash
npm run verify:mobile
```

Automated checks verify that the desktop exposes only the manual proxy + CA QR flow and that no companion/pairing product path is present. Real hardware is still required to validate Android/iPhone Wi-Fi proxy configuration, CA trust, Windows firewall reachability, and HTTPS capture for the target app.

## Manual client configuration

1. Open **Settings** and copy the proxy address.
2. Configure the development browser, emulator, device, or app you control to use that HTTP/HTTPS proxy.
3. For HTTPS inspection, import the CA certificate path shown in **Settings** into that development client.
4. Remove the CA trust when you no longer need interception.

Trace Local does not install trust certificates automatically and binds its control surface to loopback by default.

The control and CA-download listeners validate Host and browser-origin headers; body-bearing control mutations require `application/json`. The proxy blocks forwarding to this daemon's control endpoint, including hostname aliases.

CA initialization is serialized across processes sharing the same data directory. If a process crashes while creating the CA, initialization fails with the `.ca-initialize.lock` path; remove that lock only after all Trace Local processes using that directory have stopped. An expired CA blocks new CA-download tokens with `503 ca_expired` and requires restarting Trace Local so the proxy and clients use the regenerated identity together.

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

`e2e:desktop` launches the real Electron entry with temporary ports, Trace Local data, and Electron user data. It sends real proxy traffic, opens request details in the renderer, exercises Map Local create/edit/toggle/delete behavior, verifies response-file editing security, generates a real CA download QR through the desktop UI, downloads the certificate, and checks that proxy/control/CA-download/debugger ports are released on shutdown.

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

# Trace Local

Local-first HTTP/HTTPS traffic inspector and Map Local proxy for Windows and macOS. It includes a CLI, an embedded local CA for HTTPS interception, persistent Map Local rules, HAR export, live SSE updates, and an Electron desktop inspector.

## Quick start

```bash
npm install
npm run desktop
```

The desktop app starts an embedded proxy on a free loopback port. Use the proxy address shown in the header or **Settings**.

For CLI-only development:

```bash
npm run dev:daemon
npm run dev:cli -- --help
```

## Configure a client

1. Open **Settings** and copy the proxy address.
2. Configure the development browser, emulator, device, or app you control to use that HTTP/HTTPS proxy.
3. For HTTPS inspection, import the CA certificate path shown in **Settings** into that development client.
4. Remove the CA trust when you no longer need interception.

Trace Local does not install trust certificates automatically and binds its control surface to loopback by default.

## Map Local

Open **Map Local**, create a rule, choose a local response file, then match by full URL, host, or path. Rules are persisted locally and can be enabled, disabled, or removed without restarting the proxy.

## Verification

```bash
npm test
npm run typecheck
npm run build
npm run audit:prod
```

The production audit is expected to report no high-severity vulnerabilities. The project pins `basic-ftp` 6.2.1 through an npm override because Mockttp's proxy dependency chain otherwise resolves an affected 5.x release.

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

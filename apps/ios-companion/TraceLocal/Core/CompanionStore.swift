import Foundation
import SwiftUI
import UIKit

@MainActor
final class CompanionStore: ObservableObject {
    enum State: Equatable {
        case ready
        case pairing
        case certificateRequired
        case readyToConnect
        case connecting
        case connected
        case disconnecting
        case error(String)

        var title: String {
            switch self {
            case .ready: return "Ready to pair"
            case .pairing: return "Pairing"
            case .certificateRequired: return "Certificate required"
            case .readyToConnect: return "Ready to connect"
            case .connecting: return "Connecting"
            case .connected: return "Connected"
            case .disconnecting: return "Disconnecting"
            case .error: return "Needs attention"
            }
        }
    }

    @Published private(set) var state: State = .ready
    @Published private(set) var detail = "Scan the pairing QR shown by Trace Local desktop."
    @Published var showingScanner = false

    let tunnel = TunnelController()

    private let client = PairingClient()
    private let identity = DeviceIdentity()
    private(set) var pairing: PairingPayload?

    var caIsReady: Bool {
        guard let pairing else { return false }
        return identity.trustsFingerprint(pairing.caFingerprint256)
    }

    var canConnect: Bool {
        pairing != nil && caIsReady && state != .connecting
    }

    func redeem(_ url: URL) {
        state = .pairing
        detail = "Contacting the desktop…"

        Task {
            do {
                let payload = try await client.redeem(url)
                guard !payload.isExpired else {
                    throw PairingClientError.server(410, "Pairing authorization expired. Generate a new QR.")
                }
                pairing = payload
                updateReadyState()
            } catch {
                state = .error(error.localizedDescription)
                detail = error.localizedDescription
            }
        }
    }

    func redeemDeepLink(_ url: URL) {
        guard url.scheme?.lowercased() == "tracelocal",
              url.host?.lowercased() == "pair",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let raw = components.queryItems?.first(where: { $0.name == "url" })?.value,
              let pairingUrl = URL(string: raw) else {
            state = .error("Invalid Trace Local deep link.")
            detail = "Scan a fresh pairing QR from the desktop app."
            return
        }
        redeem(pairingUrl)
    }

    func openCertificateInstaller() {
        guard let pairing, let url = URL(string: pairing.caDownloadUrl) else {
            state = .error("No certificate download URL is available.")
            return
        }
        UIApplication.shared.open(url)
        state = .certificateRequired
        detail = "Install the downloaded Trace Local CA, then enable full trust in Settings > General > About > Certificate Trust Settings. Return here and confirm when complete."
    }

    func confirmCertificateTrusted() {
        guard let pairing else { return }
        identity.markFingerprintTrusted(pairing.caFingerprint256)
        updateReadyState()
    }

    func connect() {
        guard let pairing else {
            state = .error("Scan a pairing QR first.")
            return
        }
        guard !pairing.isExpired else {
            state = .error("Pairing authorization expired. Scan a fresh QR.")
            return
        }
        guard caIsReady else {
            state = .certificateRequired
            detail = "Install and fully trust the Trace Local CA before connecting."
            return
        }

        state = .connecting
        detail = "Creating the paired device session…"

        Task {
            do {
                let session = try await client.connect(
                    pairing: pairing,
                    deviceId: identity.deviceId,
                    name: identity.displayName
                )
                try await tunnel.connect(pairing: pairing, session: session)
                state = .connected
                detail = "Trace Local proxy session is active."
            } catch {
                state = .error(error.localizedDescription)
                detail = error.localizedDescription
            }
        }
    }

    func disconnect() {
        state = .disconnecting
        detail = "Restoring normal routing…"
        tunnel.disconnect()
        state = .readyToConnect
        detail = "Disconnected. Scan again if the desktop pairing authorization has expired."
    }

    private func updateReadyState() {
        guard let pairing else {
            state = .ready
            detail = "Scan the pairing QR shown by Trace Local desktop."
            return
        }

        if identity.trustsFingerprint(pairing.caFingerprint256) {
            state = .readyToConnect
            detail = "Paired with \(pairing.desktopId). The known CA fingerprint matches."
        } else {
            state = .certificateRequired
            detail = "Paired with \(pairing.desktopId). Install and fully trust the Trace Local CA once."
        }
    }
}

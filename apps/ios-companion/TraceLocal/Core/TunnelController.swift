import Foundation
import NetworkExtension
import Combine

@MainActor
final class TunnelController: ObservableObject {
    @Published private(set) var status: NEVPNStatus = .invalid

    private var manager: NETunnelProviderManager?
    private var statusObserver: NSObjectProtocol?

    init() {
        statusObserver = NotificationCenter.default.addObserver(
            forName: .NEVPNStatusDidChange,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let connection = notification.object as? NEVPNConnection else { return }
            self?.status = connection.status
        }
    }

    deinit {
        if let statusObserver {
            NotificationCenter.default.removeObserver(statusObserver)
        }
    }

    func connect(pairing: PairingPayload, session: DeviceSessionEnvelope) async throws {
        guard let proxy = pairing.proxy else {
            throw PairingClientError.invalidResponse
        }

        let manager = try await loadManager()
        let tunnelProtocol = NETunnelProviderProtocol()
        tunnelProtocol.providerBundleIdentifier = "com.tracelocal.companion.PacketTunnel"
        tunnelProtocol.serverAddress = pairing.desktopId
        tunnelProtocol.providerConfiguration = [
            "proxyHost": proxy.host,
            "proxyPort": proxy.port,
            "apiBaseUrl": pairing.apiBaseUrl,
            "sessionId": session.session.sessionId,
            "heartbeatIntervalMs": session.heartbeatIntervalMs,
            "staleAfterMs": session.staleAfterMs,
        ]

        manager.localizedDescription = "Trace Local"
        manager.protocolConfiguration = tunnelProtocol
        manager.isEnabled = true

        try await save(manager)
        try await load(manager)
        self.manager = manager
        self.status = manager.connection.status
        try manager.connection.startVPNTunnel()
    }

    func disconnect() {
        manager?.connection.stopVPNTunnel()
    }

    private func loadManager() async throws -> NETunnelProviderManager {
        let managers = try await loadAllManagers()
        let manager = managers.first(where: {
            ($0.protocolConfiguration as? NETunnelProviderProtocol)?.providerBundleIdentifier ==
                "com.tracelocal.companion.PacketTunnel"
        }) ?? NETunnelProviderManager()
        try await load(manager)
        return manager
    }

    private func loadAllManagers() async throws -> [NETunnelProviderManager] {
        try await withCheckedThrowingContinuation { continuation in
            NETunnelProviderManager.loadAllFromPreferences { managers, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: managers ?? [])
                }
            }
        }
    }

    private func save(_ manager: NETunnelProviderManager) async throws {
        try await withCheckedThrowingContinuation { continuation in
            manager.saveToPreferences { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
    }

    private func load(_ manager: NETunnelProviderManager) async throws {
        try await withCheckedThrowingContinuation { continuation in
            manager.loadFromPreferences { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
    }
}

import Foundation
import NetworkExtension

final class PacketTunnelProvider: NEPacketTunnelProvider {
    private var heartbeatTask: Task<Void, Never>?
    private var apiBaseUrl = ""
    private var sessionId = ""
    private var heartbeatIntervalMs = 3_000
    private var staleAfterMs = 15_000
    private var lastHeartbeatSuccess = Date()

    override func startTunnel(
        options: [String : NSObject]?,
        completionHandler: @escaping (Error?) -> Void
    ) {
        guard
            let configuration = protocolConfiguration as? NETunnelProviderProtocol,
            let provider = configuration.providerConfiguration,
            let proxyHost = provider["proxyHost"] as? String,
            let proxyPort = provider["proxyPort"] as? Int,
            let apiBaseUrl = provider["apiBaseUrl"] as? String,
            let sessionId = provider["sessionId"] as? String
        else {
            completionHandler(NSError(
                domain: "TraceLocal",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Incomplete Trace Local tunnel configuration"]
            ))
            return
        }

        self.apiBaseUrl = apiBaseUrl
        self.sessionId = sessionId
        self.heartbeatIntervalMs = provider["heartbeatIntervalMs"] as? Int ?? 3_000
        self.staleAfterMs = provider["staleAfterMs"] as? Int ?? 15_000
        self.lastHeartbeatSuccess = Date()

        let settings = NEPacketTunnelNetworkSettings(tunnelRemoteAddress: proxyHost)

        let ipv4 = NEIPv4Settings(
            addresses: ["192.0.2.2"],
            subnetMasks: ["255.255.255.255"]
        )
        // Deliberately do not install a default route. Without a packet forwarder,
        // a default route would blackhole traffic that does not honor the HTTP proxy.
        ipv4.includedRoutes = []
        settings.ipv4Settings = ipv4

        let proxy = NEProxySettings()
        proxy.httpEnabled = true
        proxy.httpServer = NEProxyServer(address: proxyHost, port: proxyPort)
        proxy.httpsEnabled = true
        proxy.httpsServer = NEProxyServer(address: proxyHost, port: proxyPort)
        proxy.excludeSimpleHostnames = false
        proxy.matchDomains = [""]
        settings.proxySettings = proxy

        setTunnelNetworkSettings(settings) { [weak self] error in
            guard error == nil else {
                completionHandler(error)
                return
            }
            self?.startHeartbeatLoop()
            completionHandler(nil)
        }
    }

    override func stopTunnel(
        with reason: NEProviderStopReason,
        completionHandler: @escaping () -> Void
    ) {
        heartbeatTask?.cancel()
        heartbeatTask = nil

        let apiBaseUrl = self.apiBaseUrl
        let sessionId = self.sessionId
        Task {
            await Self.acknowledgeDisconnected(apiBaseUrl: apiBaseUrl, sessionId: sessionId)
            completionHandler()
        }
    }

    private func startHeartbeatLoop() {
        heartbeatTask?.cancel()
        heartbeatTask = Task { [weak self] in
            guard let self else { return }

            while !Task.isCancelled {
                do {
                    try await Task.sleep(nanoseconds: UInt64(self.heartbeatIntervalMs) * 1_000_000)
                    let heartbeat = try await Self.heartbeat(
                        apiBaseUrl: self.apiBaseUrl,
                        sessionId: self.sessionId
                    )
                    self.lastHeartbeatSuccess = Date()

                    if heartbeat.disconnectRequested == true || heartbeat.restoreRouting == true {
                        await Self.acknowledgeDisconnected(
                            apiBaseUrl: self.apiBaseUrl,
                            sessionId: self.sessionId
                        )
                        self.cancelTunnelWithError(nil)
                        return
                    }
                } catch is CancellationError {
                    return
                } catch {
                    let elapsed = Date().timeIntervalSince(self.lastHeartbeatSuccess) * 1000
                    if elapsed >= Double(self.staleAfterMs) {
                        self.cancelTunnelWithError(NSError(
                            domain: "TraceLocal",
                            code: 2,
                            userInfo: [NSLocalizedDescriptionKey: "Trace Local desktop is unreachable"]
                        ))
                        return
                    }
                }
            }
        }
    }

    private struct Heartbeat: Decodable {
        let disconnectRequested: Bool?
        let restoreRouting: Bool?
    }

    private static func heartbeat(apiBaseUrl: String, sessionId: String) async throws -> Heartbeat {
        guard
            let sessionPart = sessionId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
            let url = URL(string: apiBaseUrl + "/device/session/" + sessionPart + "/heartbeat")
        else {
            throw URLError(.badURL)
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = Data("{}".utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let session = directSession()
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        if http.statusCode == 404 {
            return Heartbeat(disconnectRequested: true, restoreRouting: true)
        }
        guard (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(Heartbeat.self, from: data)
    }

    private static func acknowledgeDisconnected(apiBaseUrl: String, sessionId: String) async {
        guard
            !apiBaseUrl.isEmpty,
            !sessionId.isEmpty,
            let sessionPart = sessionId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
            let url = URL(string: apiBaseUrl + "/device/session/" + sessionPart + "/disconnected")
        else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = Data("{}".utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        _ = try? await directSession().data(for: request)
    }

    private static func directSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 6
        configuration.connectionProxyDictionary = [:]
        return URLSession(configuration: configuration)
    }
}

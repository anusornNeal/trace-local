import Foundation

enum PairingClientError: LocalizedError {
    case invalidResponse
    case server(Int, String)
    case unsupportedProtocol(Int)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "Trace Local returned an invalid response."
        case let .server(status, message):
            return "Trace Local returned HTTP \(status): \(message)"
        case let .unsupportedProtocol(version):
            return "Unsupported pairing protocol \(version)."
        }
    }
}

actor PairingClient {
    private let session: URLSession
    private let decoder = JSONDecoder()

    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 8
        configuration.timeoutIntervalForResource = 12
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.connectionProxyDictionary = [:]
        self.session = URLSession(configuration: configuration)
    }

    func redeem(_ url: URL) async throws -> PairingPayload {
        let data = try await requestData(url, method: "GET", body: Optional<EmptyBody>.none)
        let payload = try decoder.decode(PairingPayload.self, from: data)
        guard payload.protocolVersion == 1 else {
            throw PairingClientError.unsupportedProtocol(payload.protocolVersion)
        }
        return payload
    }

    func connect(pairing: PairingPayload, deviceId: String, name: String) async throws -> DeviceSessionEnvelope {
        struct Body: Encodable {
            let pairingId: String
            let deviceId: String
            let name: String
            let platform = "ios"
        }

        guard let url = URL(string: pairing.apiBaseUrl + "/device/session") else {
            throw PairingClientError.invalidResponse
        }
        return try await request(url, method: "POST", body: Body(pairingId: pairing.pairingId, deviceId: deviceId, name: name))
    }

    func heartbeat(apiBaseUrl: String, sessionId: String) async throws -> HeartbeatEnvelope {
        guard let sessionPart = sessionId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              let url = URL(string: apiBaseUrl + "/device/session/" + sessionPart + "/heartbeat") else {
            throw PairingClientError.invalidResponse
        }
        return try await request(url, method: "POST", body: EmptyBody())
    }

    func acknowledgeDisconnected(apiBaseUrl: String, sessionId: String) async {
        guard let sessionPart = sessionId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              let url = URL(string: apiBaseUrl + "/device/session/" + sessionPart + "/disconnected") else {
            return
        }
        _ = try? await requestData(url, method: "POST", body: EmptyBody())
    }

    private struct EmptyBody: Encodable {}

    private func request<T: Decodable, Body: Encodable>(_ url: URL, method: String, body: Body?) async throws -> T {
        let data = try await requestData(url, method: method, body: body)
        return try decoder.decode(T.self, from: data)
    }

    private func requestData<Body: Encodable>(_ url: URL, method: String, body: Body?) async throws -> Data {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw PairingClientError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let message = String(data: data, encoding: .utf8) ?? ""
            throw PairingClientError.server(http.statusCode, message)
        }
        return data
    }
}

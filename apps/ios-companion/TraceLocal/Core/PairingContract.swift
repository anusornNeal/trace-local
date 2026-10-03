import Foundation

struct PairingPayload: Codable, Equatable {
    let protocolVersion: Int
    let pairingId: String
    let desktopId: String
    let proxyAddress: String
    let caFingerprint256: String
    let apiBaseUrl: String
    let caDownloadUrl: String
    let issuedAt: Int64
    let expiresAt: Int64

    var normalizedFingerprint: String {
        caFingerprint256
            .unicodeScalars
            .filter { CharacterSet.hexadecimalDigits.contains($0) }
            .map(String.init)
            .joined()
            .uppercased()
    }

    var isExpired: Bool {
        Int64(Date().timeIntervalSince1970 * 1000) >= expiresAt
    }

    var proxy: (host: String, port: Int)? {
        Self.parseProxyAddress(proxyAddress)
    }

    static func parseProxyAddress(_ value: String) -> (host: String, port: Int)? {
        if value.hasPrefix("[") {
            guard
                let close = value.firstIndex(of: "]"),
                value.index(after: close) < value.endIndex,
                value[value.index(after: close)] == ":",
                let port = Int(value[value.index(close, offsetBy: 2)...]),
                (1...65_535).contains(port)
            else { return nil }

            let host = String(value[value.index(after: value.startIndex)..<close])
            return host.isEmpty ? nil : (host, port)
        }

        guard
            let separator = value.lastIndex(of: ":"),
            separator > value.startIndex,
            let port = Int(value[value.index(after: separator)...]),
            (1...65_535).contains(port)
        else { return nil }

        return (String(value[..<separator]), port)
    }
}

struct DeviceSessionEnvelope: Codable {
    struct Session: Codable {
        let sessionId: String
    }

    let session: Session
    let heartbeatIntervalMs: Int
    let staleAfterMs: Int
    let restoreRoutingOnDisconnect: Bool
}

struct HeartbeatEnvelope: Codable {
    let disconnectRequested: Bool?
    let restoreRouting: Bool?
}

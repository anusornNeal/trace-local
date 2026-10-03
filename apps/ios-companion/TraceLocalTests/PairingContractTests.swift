import XCTest
@testable import TraceLocal

final class PairingContractTests: XCTestCase {
    func testParsesIPv4Proxy() {
        let value = PairingPayload.parseProxyAddress("192.168.1.20:8888")
        XCTAssertEqual(value?.host, "192.168.1.20")
        XCTAssertEqual(value?.port, 8888)
    }

    func testParsesIPv6Proxy() {
        let value = PairingPayload.parseProxyAddress("[fe80::1234]:4040")
        XCTAssertEqual(value?.host, "fe80::1234")
        XCTAssertEqual(value?.port, 4040)
    }

    func testRejectsInvalidPort() {
        XCTAssertNil(PairingPayload.parseProxyAddress("127.0.0.1:70000"))
    }

    func testNormalizesFingerprint() throws {
        let json = """
        {
          "protocolVersion": 1,
          "pairingId": "p",
          "desktopId": "d",
          "proxyAddress": "127.0.0.1:8888",
          "caFingerprint256": "aa:bb cc-dd",
          "apiBaseUrl": "http://127.0.0.1:4041",
          "caDownloadUrl": "http://127.0.0.1:4041/ca/t",
          "issuedAt": 1,
          "expiresAt": 9999999999999
        }
        """
        let payload = try JSONDecoder().decode(PairingPayload.self, from: Data(json.utf8))
        XCTAssertEqual(payload.normalizedFingerprint, "AABBCCDD")
    }
}

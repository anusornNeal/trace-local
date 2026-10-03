import Foundation
import Security
import UIKit

final class DeviceIdentity {
    private let service = "com.tracelocal.companion"
    private let defaults = UserDefaults.standard

    var deviceId: String {
        if let existing = keychainString(account: "device-id"), !existing.isEmpty {
            return existing
        }

        let created = UUID().uuidString
        setKeychainString(created, account: "device-id")
        return created
    }

    var displayName: String {
        let model = UIDevice.current.model.trimmingCharacters(in: .whitespacesAndNewlines)
        return model.isEmpty ? "iPhone" : model
    }

    func trustsFingerprint(_ fingerprint: String) -> Bool {
        normalized(defaults.string(forKey: "trusted-ca-fingerprint") ?? "") == normalized(fingerprint)
    }

    func markFingerprintTrusted(_ fingerprint: String) {
        defaults.set(normalized(fingerprint), forKey: "trusted-ca-fingerprint")
    }

    private func normalized(_ value: String) -> String {
        value.unicodeScalars
            .filter { CharacterSet.hexadecimalDigits.contains($0) }
            .map(String.init)
            .joined()
            .uppercased()
    }

    private func keychainString(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    private func setKeychainString(_ value: String, account: String) {
        let data = Data(value.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        var attributes = query
        attributes[kSecValueData as String] = data
        SecItemAdd(attributes as CFDictionary, nil)
    }
}

import SwiftUI

struct ContentView: View {
    @ObservedObject var store: CompanionStore
    @State private var pastedLink = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(store.state.title)
                        .font(.headline)
                    Text(store.detail)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                Section("Pairing") {
                    Button("Scan pairing QR") {
                        store.showingScanner = true
                    }

                    HStack {
                        TextField("Pairing URL", text: $pastedLink)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Button("Use") {
                            if let url = URL(string: pastedLink.trimmingCharacters(in: .whitespacesAndNewlines)) {
                                store.redeem(url)
                            }
                        }
                        .disabled(URL(string: pastedLink.trimmingCharacters(in: .whitespacesAndNewlines)) == nil)
                    }
                }

                if store.pairing != nil {
                    Section("Certificate") {
                        if store.caIsReady {
                            Label("Known CA fingerprint confirmed", systemImage: "checkmark.shield.fill")
                                .foregroundStyle(.green)
                        } else {
                            Button("Install Trace Local CA") {
                                store.openCertificateInstaller()
                            }
                            Button("I installed and enabled full trust") {
                                store.confirmCertificateTrusted()
                            }
                        }
                    }

                    Section("Connection") {
                        Button("Connect") {
                            store.connect()
                        }
                        .disabled(!store.canConnect)

                        Button("Disconnect", role: .destructive) {
                            store.disconnect()
                        }
                    }
                }

                Section("Routing scope") {
                    Text("Trace Local configures the Network Extension HTTP/HTTPS proxy without installing a default packet route. This avoids blackholing non-proxy traffic. Apps that bypass the system proxy are not transparently intercepted.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Trace Local")
            .sheet(isPresented: $store.showingScanner) {
                ScannerView(
                    onCode: { value in
                        store.showingScanner = false
                        if let url = URL(string: value) {
                            store.redeem(url)
                        }
                    },
                    onCancel: {
                        store.showingScanner = false
                    }
                )
                .ignoresSafeArea()
            }
        }
    }
}

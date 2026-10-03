import SwiftUI

@main
struct TraceLocalApp: App {
    @StateObject private var store = CompanionStore()

    var body: some Scene {
        WindowGroup {
            ContentView(store: store)
                .onOpenURL { url in
                    store.redeemDeepLink(url)
                }
        }
    }
}

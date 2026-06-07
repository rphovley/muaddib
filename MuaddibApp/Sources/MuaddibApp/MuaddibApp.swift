import SwiftUI

@main
struct MuaddibApp: App {
    @State private var monitor = WorkerMonitor()
    @State private var daemonManager = DispatchDaemonManager()

    var body: some Scene {
        MenuBarExtra {
            ContentView(monitor: monitor, daemonManager: daemonManager)
        } label: {
            Label("muaddib", systemImage: "cpu")
        }
        .menuBarExtraStyle(.window)
    }
}

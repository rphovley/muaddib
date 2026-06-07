import SwiftUI

@main
struct MuaddibApp: App {
    @State private var monitor = WorkerMonitor()
    @State private var daemonManager = DispatchDaemonManager()
    @State private var panelManager = PinnedPanelManager()

    var body: some Scene {
        MenuBarExtra {
            ContentView(monitor: monitor, daemonManager: daemonManager, panelManager: panelManager)
        } label: {
            Label("muaddib", systemImage: "cpu")
        }
        .menuBarExtraStyle(.window)
    }
}

import SwiftUI

@main
struct MuaddibApp: App {
    @State private var monitor = WorkerMonitor()
    @State private var daemonManager = DispatchDaemonManager()
    @State private var panelManager = PinnedPanelManager()
    @State private var newAgentPanelManager = NewAgentPanelManager()
    @State private var checker = InstallChecker()

    var body: some Scene {
        MenuBarExtra {
            ContentView(monitor: monitor, daemonManager: daemonManager, panelManager: panelManager, newAgentPanelManager: newAgentPanelManager, checker: checker)
        } label: {
            Label("muaddib", systemImage: "cpu")
        }
        .menuBarExtraStyle(.window)
    }
}

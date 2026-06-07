import SwiftUI

struct ContentView: View {
    let monitor: WorkerMonitor
    let daemonManager: DispatchDaemonManager
    @State private var isPinned = false
    @State private var hostWindow: NSWindow?
    @State private var defaultWindowLevel: NSWindow.Level = .normal

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            headerBar
            Divider()
            if monitor.workers.isEmpty {
                emptyState
            } else {
                workerList
            }
        }
        .frame(width: 340)
        .background(
            WindowReader { window in
                // Capture window reference on first appearance only
                guard self.hostWindow == nil else { return }
                self.hostWindow = window
                self.defaultWindowLevel = window.level
            }
        )
        .background(Color(NSColor.windowBackgroundColor))
    }

    private var headerBar: some View {
        HStack(spacing: 8) {
            Text("muaddib fleet")
                .font(.headline)
            Spacer()
            Button(action: { daemonManager.toggle() }) {
                Image(systemName: daemonManager.isRunning ? "bolt.fill" : "bolt.slash")
                    .foregroundStyle(daemonManager.isRunning ? Color.green : Color.secondary)
            }
            .buttonStyle(.plain)
            .help(daemonManager.isRunning ? "Dispatcher running — click to stop" : "Dispatcher stopped — click to start")
            Button(action: { monitor.refresh() }) {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.plain)
            .help("Refresh now")

            Button(action: togglePin) {
                Image(systemName: isPinned ? "pin.fill" : "pin")
                    .foregroundStyle(isPinned ? Color.accentColor : Color.primary)
            }
            .buttonStyle(.plain)
            .help(isPinned ? "Unpin window" : "Pin (keep visible)")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var emptyState: some View {
        Text("no workers running")
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, minHeight: 56)
            .multilineTextAlignment(.center)
    }

    private var workerList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(monitor.workers) { worker in
                    WorkerRow(worker: worker)
                    if worker.id != monitor.workers.last?.id {
                        Divider().padding(.leading, 38)
                    }
                }
            }
        }
        .frame(maxHeight: 400)
    }

    private func togglePin() {
        isPinned.toggle()
        guard let window = hostWindow else { return }
        if isPinned {
            window.level = .floating
            window.hidesOnDeactivate = false
            window.isMovable = true
            window.isMovableByWindowBackground = true
        } else {
            window.level = defaultWindowLevel
            window.hidesOnDeactivate = true
            window.isMovable = false
            window.isMovableByWindowBackground = false
        }
    }
}

struct WorkerRow: View {
    let worker: WorkerInfo

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(dotColor)
                .frame(width: 9, height: 9)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text("worker-\(worker.id)")
                        .font(.system(size: 13, weight: .medium))
                    if !worker.ticketId.isEmpty {
                        Text(worker.ticketId)
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                    }
                }
                Text(worker.displayLabel)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            Button("Attach") {
                TerminalLauncher.attachToWorker(
                    containerId: worker.containerId,
                    workerIndex: worker.id
                )
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .contentShape(Rectangle())
    }

    private var dotColor: Color {
        switch worker.statusCategory {
        case .ok:        return .green
        case .attention: return .yellow
        case .error:     return .red
        case .idle:      return .gray
        }
    }
}

import SwiftUI

struct ContentView: View {
    let monitor: WorkerMonitor
    let daemonManager: DispatchDaemonManager
    let panelManager: PinnedPanelManager
    private var needsYouCount: Int {
        monitor.workers.filter { $0.statusCategory == .attention }.count
    }

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
        .background(Color(NSColor.windowBackgroundColor))
    }

    private var headerBar: some View {
        HStack(alignment: .center, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Fleet")
                    .font(.headline)
                if !monitor.workers.isEmpty {
                    let suffix = needsYouCount > 0 ? " · \(needsYouCount) needs you" : ""
                    Text("\(monitor.workers.count) agent\(monitor.workers.count == 1 ? "" : "s")\(suffix)")
                        .font(.system(size: 11))
                        .foregroundStyle(
                            needsYouCount > 0
                                ? Color(red: 0.95, green: 0.78, blue: 0.35)
                                : Color.secondary
                        )
                }
            }
            Spacer()
            Button(action: { daemonManager.toggle() }) {
                Image(systemName: daemonManager.isRunning ? "bolt.fill" : "bolt.slash")
                    .foregroundStyle(daemonManager.isRunning ? Color.green : Color.secondary)
            }
            .buttonStyle(.plain)
            .help(daemonManager.isRunning ? "Dispatcher running — click to stop" : "Dispatcher stopped — click to start")

            Button(action: togglePin) {
                if panelManager.isOpen {
                    HStack(spacing: 4) {
                        Image(systemName: "pin.fill")
                            .font(.system(size: 11))
                        Text("Pinned")
                            .font(.system(size: 12, weight: .medium))
                    }
                    .foregroundStyle(Color.accentColor)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color.accentColor.opacity(0.15))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                } else {
                    Image(systemName: "pin")
                        .foregroundStyle(Color.primary)
                }
            }
            .buttonStyle(.plain)
            .help(panelManager.isOpen ? "Unpin (close panel)" : "Pin (keep on screen)")

            Button(action: { NSApplication.shared.terminate(nil) }) {
                Image(systemName: "xmark")
                    .foregroundStyle(Color.secondary)
            }
            .buttonStyle(.plain)
            .help("Quit muaddib")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    private var emptyState: some View {
        Text("no workers running")
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, minHeight: 56)
            .multilineTextAlignment(.center)
    }

    private var sortedWorkers: [WorkerInfo] {
        monitor.workers.sorted {
            let pa = urgencyPriority($0.statusCategory)
            let pb = urgencyPriority($1.statusCategory)
            if pa != pb { return pa < pb }
            return $0.id < $1.id
        }
    }

    private func urgencyPriority(_ category: WorkerInfo.StatusCategory) -> Int {
        switch category {
        case .attention: return 0
        case .pr:        return 1
        case .ok:        return 2
        case .error:     return 3
        case .idle:      return 4
        }
    }

    private var workerList: some View {
        let workers = sortedWorkers
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(workers) { worker in
                    WorkerRow(worker: worker)
                    if worker.id != workers.last?.id {
                        Divider().padding(.leading, 56)
                    }
                }
            }
        }
        .frame(maxHeight: 400)
    }

    private func togglePin() {
        panelManager.toggle(monitor: monitor)
    }
}

struct WorkerRow: View {
    let worker: WorkerInfo
    @State private var copied = false

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle()
                    .fill(statusColor.opacity(0.18))
                    .frame(width: 34, height: 34)
                if !worker.statusGlyph.isEmpty {
                    Image(systemName: worker.statusGlyph)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(statusColor)
                } else {
                    Circle()
                        .fill(statusColor)
                        .frame(width: 8, height: 8)
                }
            }

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text("worker-\(worker.id)")
                        .font(.system(size: 13, weight: .semibold))
                    if !worker.ticketId.isEmpty {
                        Text(worker.ticketId)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Color(NSColor.controlBackgroundColor))
                            .clipShape(RoundedRectangle(cornerRadius: 4))
                    }
                }
                HStack(spacing: 4) {
                    Text(worker.displayLabel)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    if !worker.elapsedLabel.isEmpty {
                        Text("· \(worker.elapsedLabel)")
                            .font(.system(size: 11))
                            .foregroundStyle(Color(white: 0.4))
                    }
                }
            }

            Spacer()

            Button(copied ? "Copied" : "Copy") {
                TerminalLauncher.copyAttachCommand(
                    containerId: worker.containerId,
                    workerIndex: worker.id
                )
                copied = true
                Task {
                    try? await Task.sleep(for: .milliseconds(1500))
                    copied = false
                }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }

    private var statusColor: Color {
        switch worker.statusCategory {
        case .ok:        return Color(red: 0.55, green: 0.88, blue: 0.65)
        case .pr:        return Color(red: 0.72, green: 0.65, blue: 1.0)
        case .attention: return Color(red: 0.95, green: 0.78, blue: 0.35)
        case .error:     return Color(red: 0.92, green: 0.52, blue: 0.52)
        case .idle:      return Color(white: 0.55)
        }
    }
}

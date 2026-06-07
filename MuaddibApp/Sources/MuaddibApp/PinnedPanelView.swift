import SwiftUI

struct PinnedPanelView: View {
    let monitor: WorkerMonitor
    let panelManager: PinnedPanelManager

    var body: some View {
        ZStack(alignment: .topTrailing) {
            // Pills row — natural width, capped at 300px before wrapping
            Group {
                if monitor.workers.isEmpty {
                    Text("no workers")
                        .font(.system(size: 11))
                        .foregroundStyle(Color(white: 0.5))
                } else {
                    HStack(spacing: 8) {
                        ForEach(monitor.workers) { worker in
                            WorkerPill(worker: worker)
                        }
                    }
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 10)
            // Shrink to hug pill content, but never exceed 300px
            .frame(maxWidth: 300)
            .fixedSize(horizontal: true, vertical: false)

            // Unpin button sits in the top-right corner
            Button(action: { panelManager.close() }) {
                Image(systemName: "pin.fill")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.blue)
            }
            .buttonStyle(.plain)
            .padding(6)
        }
        .background(Color(white: 0.12))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }
}

struct WorkerPill: View {
    let worker: WorkerInfo
    @State private var copied = false

    var body: some View {
        Button(action: copy) {
            Text(copied ? "copied!" : label)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(pillColor)
                .lineLimit(1)
                .padding(.horizontal, 7)
                .padding(.vertical, 4)
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(pillColor, lineWidth: 1.5)
                )
        }
        .buttonStyle(.plain)
        .animation(.easeInOut(duration: 0.12), value: copied)
    }

    private var label: String {
        worker.ticketId.isEmpty ? "w\(worker.id)" : worker.ticketId
    }

    private func copy() {
        TerminalLauncher.copyAttachCommand(
            containerId: worker.containerId,
            workerIndex: worker.id
        )
        copied = true
        Task {
            try? await Task.sleep(for: .milliseconds(800))
            copied = false
        }
    }

    private var pillColor: Color {
        switch worker.statusCategory {
        case .ok:        return Color(red: 0.55, green: 0.88, blue: 0.65)
        case .attention: return Color(red: 0.92, green: 0.85, blue: 0.45)
        case .error:     return Color(red: 0.92, green: 0.52, blue: 0.52)
        case .idle:      return Color(white: 0.62)
        }
    }
}

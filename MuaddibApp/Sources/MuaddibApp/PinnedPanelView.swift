import SwiftUI

struct PinnedPanelView: View {
    let monitor: WorkerMonitor
    let panelManager: PinnedPanelManager
    @State private var isHovered = false

    private var needsYouCount: Int {
        monitor.workers.filter { $0.statusCategory == .attention }.count
    }

    private var fleetIconColor: Color {
        let cats = monitor.workers.map { $0.statusCategory }
        if cats.contains(.attention) { return Color(red: 0.95, green: 0.78, blue: 0.35) }
        if cats.contains(.pr)        { return Color(red: 0.72, green: 0.65, blue: 1.0) }
        if cats.contains(.ok)        { return Color(red: 0.55, green: 0.88, blue: 0.65) }
        if cats.contains(.error)     { return Color(red: 0.92, green: 0.52, blue: 0.52) }
        return Color(white: 0.5)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Fleet title row
            HStack(spacing: 8) {
                gripHandle

                Image(systemName: "square.stack")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(fleetIconColor)

                Text("Fleet · \(monitor.workers.count)")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color(white: 0.92))

                if needsYouCount > 0 {
                    Text("\(needsYouCount) needs you")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(Color(red: 0.95, green: 0.78, blue: 0.35))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color(red: 0.95, green: 0.78, blue: 0.35).opacity(0.18))
                        .clipShape(RoundedRectangle(cornerRadius: 5))
                }

                if isHovered {
                    Button(action: { panelManager.close() }) {
                        Image(systemName: "xmark")
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(Color(white: 0.55))
                    }
                    .buttonStyle(.plain)
                    .help("Unpin")
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)

            // Worker pills — fan out on hover
            if isHovered && !monitor.workers.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(monitor.workers) { worker in
                        WorkerPill(worker: worker)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
            }
        }
        .fixedSize(horizontal: true, vertical: false)
        .background(Color(white: 0.12))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .onHover { isHovered = $0 }
    }

    private var gripHandle: some View {
        let dot = Circle().frame(width: 2, height: 2)
        return VStack(spacing: 2.5) {
            HStack(spacing: 2.5) { dot; dot }
            HStack(spacing: 2.5) { dot; dot }
            HStack(spacing: 2.5) { dot; dot }
        }
        .foregroundStyle(Color(white: 0.45))
    }
}

struct WorkerPill: View {
    let worker: WorkerInfo
    @State private var copied = false
    @State private var isHovered = false

    var body: some View {
        Button(action: copy) {
            HStack(spacing: 4) {
                if !worker.statusGlyph.isEmpty {
                    Image(systemName: worker.statusGlyph)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(pillColor)
                }
                Text(copied ? "copied!" : pillLabel)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(pillColor)
                    .lineLimit(1)
            }
            .padding(.horizontal, 7)
            .padding(.vertical, 4)
            .background(pillColor.opacity(0.18))
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .stroke(pillColor, lineWidth: 1.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
        .animation(.easeInOut(duration: 0.12), value: copied)
        .onHover { isHovered = $0 }
    }

    private var pillLabel: String {
        if isHovered {
            let elapsed = worker.elapsedLabel.isEmpty ? "" : " · \(worker.elapsedLabel)"
            return "worker-\(worker.id) · \(worker.displayLabel)\(elapsed)"
        }
        return worker.ticketId.isEmpty ? "w\(worker.id)" : worker.ticketId
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
        case .pr:        return Color(red: 0.72, green: 0.65, blue: 1.0)
        case .attention: return Color(red: 0.95, green: 0.78, blue: 0.35)
        case .error:     return Color(red: 0.92, green: 0.52, blue: 0.52)
        case .idle:      return Color(white: 0.55)
        }
    }
}

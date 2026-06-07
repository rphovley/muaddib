import SwiftUI

struct PinnedPanelView: View {
    let monitor: WorkerMonitor
    let panelManager: PinnedPanelManager
    @State private var isHovered = false
    @State private var showTooltipFor: Int? = nil
    @State private var hoverVersion: Int = 0

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

    private var quadrant: ScreenQuadrant { panelManager.screenQuadrant }
    private var openUpward: Bool { quadrant == .bottomLeft || quadrant == .bottomRight }
    private var pillsAlignment: HorizontalAlignment {
        (quadrant == .topRight || quadrant == .bottomRight) ? .trailing : .leading
    }
    private var hoveredWorker: WorkerInfo? {
        guard let id = showTooltipFor else { return nil }
        return monitor.workers.first { $0.id == id }
    }

    var body: some View {
        VStack(alignment: pillsAlignment, spacing: 8) {
            if openUpward {
                // Tooltip above pills, pills above Fleet bar.
                // Panel grows upward (windowDidResize keeps bottom-left fixed).
                if isHovered && !monitor.workers.isEmpty {
                    if let worker = hoveredWorker {
                        WorkerTooltip(worker: worker)
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                    }
                    pillsRow
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }

            fleetBar

            if !openUpward {
                // Pills below Fleet bar, tooltip below pills.
                // Panel grows downward naturally (top-left anchor = default).
                if isHovered && !monitor.workers.isEmpty {
                    pillsRow
                        .transition(.move(edge: .top).combined(with: .opacity))
                    if let worker = hoveredWorker {
                        WorkerTooltip(worker: worker)
                            .transition(.move(edge: .top).combined(with: .opacity))
                    }
                }
            }
        }
        .fixedSize(horizontal: true, vertical: false)
        .onHover { hovered in
            withAnimation(.easeInOut(duration: 0.15)) {
                isHovered = hovered
            }
        }
    }

    @ViewBuilder
    private var pillsRow: some View {
        HStack(spacing: 4) {
            ForEach(monitor.workers) { worker in
                WorkerPill(worker: worker) { hovered in
                    // Increment version on every enter/exit — stale tasks
                    // (e.g. from tracking-area resets when tooltip inserts)
                    // see a mismatched version and silently no-op.
                    hoverVersion += 1
                    let v = hoverVersion
                    let wid = worker.id
                    if hovered {
                        Task {
                            try? await Task.sleep(for: .milliseconds(150))
                            guard hoverVersion == v else { return }
                            withAnimation(.easeInOut(duration: 0.1)) {
                                showTooltipFor = wid
                            }
                        }
                    } else {
                        Task {
                            try? await Task.sleep(for: .milliseconds(150))
                            guard hoverVersion == v else { return }
                            withAnimation(.easeInOut(duration: 0.1)) {
                                showTooltipFor = nil
                            }
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 4)
    }

    private var fleetBar: some View {
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
                .transition(.opacity)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(white: 0.12))
        .clipShape(RoundedRectangle(cornerRadius: 14))
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
    let onHoverChange: (Bool) -> Void
    @State private var copied = false
    @State private var isPulsing = false

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
            .background(Color(white: 0.12))
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .stroke(pillColor, lineWidth: 1.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
        .scaleEffect(worker.statusCategory == .attention ? (isPulsing ? 1.05 : 1.0) : 1.0)
        .animation(.easeInOut(duration: 0.12), value: copied)
        .onHover { onHoverChange($0) }
        .onAppear {
            guard worker.statusCategory == .attention else { return }
            withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) {
                isPulsing = true
            }
        }
        .onDisappear {
            isPulsing = false
        }
    }

    private var pillLabel: String {
        let maxChars = 22
        if !worker.ticketTitle.isEmpty {
            let t = worker.ticketTitle
            return t.count > maxChars ? String(t.prefix(maxChars)) + "…" : t
        }
        if !worker.ticketId.isEmpty { return worker.ticketId }
        return "w\(worker.id)"
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

struct WorkerTooltip: View {
    let worker: WorkerInfo

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("worker-\(worker.id)")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(Color(white: 0.7))
            if !worker.ticketId.isEmpty {
                Text(worker.ticketId)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(statusColor)
            }
            Text(worker.displayLabel)
                .font(.system(size: 11))
                .foregroundStyle(Color(white: 0.88))
            if !worker.elapsedLabel.isEmpty {
                Text(worker.elapsedLabel)
                    .font(.system(size: 10))
                    .foregroundStyle(Color(white: 0.55))
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Color(white: 0.12))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(statusColor, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 10))
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

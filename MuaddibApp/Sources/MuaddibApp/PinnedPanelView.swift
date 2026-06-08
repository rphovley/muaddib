import SwiftUI

struct PinnedPanelView: View {
    let monitor: WorkerMonitor
    let panelManager: PinnedPanelManager
    @State private var isHovered = false
    @State private var hoveredWorkerId: Int? = nil

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

    var body: some View {
        VStack(alignment: pillsAlignment, spacing: 8) {
            if openUpward {
                if isHovered && !monitor.workers.isEmpty {
                    pillsRow
                        .transition(.opacity)
                }
            }

            fleetBar

            if !openUpward {
                if isHovered && !monitor.workers.isEmpty {
                    pillsRow
                        .transition(.opacity)
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
        VStack(spacing: 0) {
            if openUpward {
                Color.clear.frame(height: 68)
            }
            HStack(spacing: 4) {
                ForEach(monitor.workers) { worker in
                    WorkerPill(
                        worker: worker,
                        quadrant: quadrant,
                        isDragging: panelManager.isDragging,
                        onHoverChange: { hovered in
                            hoveredWorkerId = hovered ? worker.id : nil
                        }
                    )
                    .zIndex(hoveredWorkerId == worker.id ? 1 : 0)
                }
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
            if !openUpward {
                Color.clear.frame(height: 68)
            }
        }
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
                    .lineLimit(1)
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
        .frame(minWidth: 280)
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
    let quadrant: ScreenQuadrant
    let isDragging: Bool
    let onHoverChange: (Bool) -> Void
    @State private var copied = false
    @State private var isPulsing = false
    @State private var showCard = false
    @State private var hoverTask: Task<Void, Never>?

    private let cardHeight: CGFloat = 68

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
        }
        .buttonStyle(.plain)
        .background(pillColor.opacity(0.18))
        .background(Color(white: 0.12))
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(pillColor, lineWidth: 1.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .scaleEffect(worker.statusCategory == .attention ? (isPulsing ? 1.05 : 1.0) : 1.0)
        .animation(.easeInOut(duration: 0.12), value: copied)
        .overlay(alignment: cardAlignment) {
            if showCard && !isDragging {
                detailCard
                    .offset(y: cardYOffset)
            }
        }
        .onHover { hovered in
            hoverTask?.cancel()
            onHoverChange(hovered)
            if hovered {
                hoverTask = Task {
                    try? await Task.sleep(for: .milliseconds(120))
                    guard !Task.isCancelled else { return }
                    showCard = true
                }
            } else {
                showCard = false
            }
        }
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

    private var openUpward: Bool { quadrant == .bottomLeft || quadrant == .bottomRight }

    private var cardAlignment: Alignment {
        let v: VerticalAlignment = openUpward ? .top : .bottom
        let h: HorizontalAlignment = (quadrant == .topRight || quadrant == .bottomRight) ? .trailing : .leading
        return Alignment(horizontal: h, vertical: v)
    }

    private var cardYOffset: CGFloat { openUpward ? -cardHeight : cardHeight }

    @ViewBuilder
    private var detailCard: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("worker-\(worker.id)")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(Color(white: 0.7))
            if !worker.ticketId.isEmpty {
                Text(worker.ticketId)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(pillColor)
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
            RoundedRectangle(cornerRadius: 8)
                .stroke(pillColor, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private var pillLabel: String {
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
        case .pr:        return Color(red: 0.72, green: 0.65, blue: 1.0)
        case .attention: return Color(red: 0.95, green: 0.78, blue: 0.35)
        case .error:     return Color(red: 0.92, green: 0.52, blue: 0.52)
        case .idle:      return Color(white: 0.55)
        }
    }
}

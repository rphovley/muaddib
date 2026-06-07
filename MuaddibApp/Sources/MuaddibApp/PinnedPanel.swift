import AppKit
import SwiftUI

enum ScreenQuadrant {
    case topLeft, topRight, bottomLeft, bottomRight
}

@MainActor
@Observable
final class PinnedPanelManager: NSObject, NSWindowDelegate {
    private(set) var isOpen = false
    private var panel: NSPanel?
    var screenQuadrant: ScreenQuadrant = .bottomRight
    var isDragging: Bool = false
    // Bottom-left y kept fixed while panel grows upward (bottom-half quadrants).
    private var anchorBottom: CGFloat = 0

    func toggle(monitor: WorkerMonitor) {
        if isOpen { close() } else { open(monitor: monitor) }
    }

    func close() {
        isOpen = false
        panel?.close()
        panel = nil
    }

    private func open(monitor: WorkerMonitor) {
        isOpen = true
        if let existing = panel {
            existing.makeKeyAndOrderFront(nil)
            return
        }
        let hostingView = NSHostingView(
            rootView: PinnedPanelView(monitor: monitor, panelManager: self)
        )
        hostingView.sizingOptions = .intrinsicContentSize

        let p = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 340, height: 10),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        p.level = .floating
        p.isReleasedWhenClosed = false
        p.hidesOnDeactivate = false
        p.hasShadow = true
        p.isMovableByWindowBackground = true
        p.backgroundColor = .clear
        p.isOpaque = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        p.contentView = hostingView
        p.delegate = self
        p.center()
        p.makeKeyAndOrderFront(nil)
        self.panel = p
        anchorBottom = p.frame.origin.y
        recomputeQuadrant()
    }

    private func recomputeQuadrant() {
        guard let frame = panel?.frame,
              let screen = NSScreen.main?.visibleFrame else { return }
        let isBottom = frame.midY < screen.midY
        let isLeft = frame.midX < screen.midX
        switch (isBottom, isLeft) {
        case (true, true):   screenQuadrant = .bottomLeft
        case (true, false):  screenQuadrant = .bottomRight
        case (false, true):  screenQuadrant = .topLeft
        case (false, false): screenQuadrant = .topRight
        }
    }

    nonisolated func windowWillMove(_ notification: Notification) {
        Task { @MainActor in
            self.isDragging = true
        }
    }

    nonisolated func windowDidMove(_ notification: Notification) {
        Task { @MainActor in
            // Save the new resting bottom after user stops dragging.
            self.anchorBottom = self.panel?.frame.origin.y ?? 0
            self.recomputeQuadrant()
            self.isDragging = false
        }
    }

    // sizingOptions = .intrinsicContentSize anchors the top-left corner by
    // default, so adding pills/tooltip above the Fleet bar pushes it down.
    // Correct the origin synchronously here — before the next display refresh —
    // so the bottom-left stays fixed for bottom-half (upward-growing) panels.
    nonisolated func windowDidResize(_ notification: Notification) {
        MainActor.assumeIsolated {
            guard let panel = self.panel else { return }
            let isUpward = self.screenQuadrant == .bottomLeft
                        || self.screenQuadrant == .bottomRight
            guard isUpward else { return }
            guard abs(panel.frame.origin.y - self.anchorBottom) > 0.5 else { return }
            var frame = panel.frame
            frame.origin.y = self.anchorBottom
            panel.setFrame(frame, display: false)
        }
    }

    nonisolated func windowWillClose(_ notification: Notification) {
        Task { @MainActor in
            self.isOpen = false
            self.panel = nil
        }
    }
}

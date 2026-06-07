import AppKit
import SwiftUI

@MainActor
@Observable
final class PinnedPanelManager: NSObject, NSWindowDelegate {
    private(set) var isOpen = false
    private var panel: NSPanel?

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
        // Resize the panel automatically as the worker list grows or shrinks.
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
    }

    // Called when the user closes the panel via the title-bar X button.
    nonisolated func windowWillClose(_ notification: Notification) {
        Task { @MainActor in
            self.isOpen = false
            self.panel = nil
        }
    }
}

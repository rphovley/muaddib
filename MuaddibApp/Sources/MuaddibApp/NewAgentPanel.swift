import AppKit
import SwiftUI

@MainActor
@Observable
final class NewAgentPanelManager: NSObject, NSWindowDelegate {
    private(set) var isOpen = false
    private var panel: NSPanel?

    func open() {
        if isOpen {
            panel?.makeKeyAndOrderFront(nil)
            return
        }
        isOpen = true
        let hostingView = NSHostingView(
            rootView: NewAgentComposerView(onDone: { [weak self] in
                self?.close()
            })
        )
        hostingView.sizingOptions = .intrinsicContentSize

        let p = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 360, height: 10),
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

    func close() {
        isOpen = false
        panel?.close()
        panel = nil
    }

    nonisolated func windowWillClose(_ notification: Notification) {
        Task { @MainActor in
            self.isOpen = false
            self.panel = nil
        }
    }
}

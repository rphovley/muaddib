import AppKit
import SwiftUI

// Captures the hosting NSWindow as soon as the view appears in the window hierarchy.
struct WindowReader: NSViewRepresentable {
    let onWindow: (NSWindow) -> Void

    func makeNSView(context: Context) -> HostView {
        HostView(onWindow: onWindow)
    }

    func updateNSView(_ nsView: HostView, context: Context) {}

    final class HostView: NSView {
        private let onWindow: (NSWindow) -> Void

        init(onWindow: @escaping (NSWindow) -> Void) {
            self.onWindow = onWindow
            super.init(frame: .zero)
        }

        required init?(coder: NSCoder) { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let window {
                DispatchQueue.main.async { self.onWindow(window) }
            }
        }
    }
}

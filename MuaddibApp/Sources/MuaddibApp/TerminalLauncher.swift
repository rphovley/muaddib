import AppKit

enum TerminalLauncher {
    static func copyAttachCommand(containerId: String, workerIndex: Int) {
        let cmd = "docker exec -it \(containerId) tmux attach -t w\(workerIndex)"
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(cmd, forType: .string)
    }

    static func attachToWorker(containerId: String, workerIndex: Int) {
        let cmd = "docker exec -it \(containerId) tmux attach -t w\(workerIndex)"
        if isWarpAvailable() {
            launchInWarp(command: cmd)
        } else {
            launchInTerminal(command: cmd)
        }
    }

    private static func isWarpAvailable() -> Bool {
        NSWorkspace.shared.runningApplications.contains {
            $0.bundleIdentifier == "dev.warp.Warp-Stable"
        } || FileManager.default.fileExists(atPath: "/Applications/Warp.app")
    }

    // Opens a new Warp window and types the command via System Events.
    // Requires Accessibility access (macOS will prompt on first use).
    private static func launchInWarp(command: String) {
        let escaped = escaped(command)
        let script = """
        tell application "Warp"
            activate
        end tell
        delay 0.4
        tell application "System Events"
            tell process "Warp"
                keystroke "n" using command down
            end tell
        end tell
        delay 0.4
        tell application "System Events"
            tell process "Warp"
                keystroke "\(escaped)"
                key code 36
            end tell
        end tell
        """
        runAppleScript(script)
    }

    private static func launchInTerminal(command: String) {
        let escaped = escaped(command)
        let script = """
        tell application "Terminal"
            activate
            do script "\(escaped)"
        end tell
        """
        runAppleScript(script)
    }

    // Escape backslashes then double-quotes for embedding in an AppleScript string.
    private static func escaped(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\")
         .replacingOccurrences(of: "\"", with: "\\\"")
    }

    private static func runAppleScript(_ source: String) {
        var error: NSDictionary?
        NSAppleScript(source: source)?.executeAndReturnError(&error)
    }
}

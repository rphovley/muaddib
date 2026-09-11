import AppKit

enum TerminalLauncher {
    static func copyAttachCommand(containerId: String, workerIndex: Int) {
        let cmd = "docker exec -it \(containerId) tmux attach -t w\(workerIndex)"
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(cmd, forType: .string)
    }

    static func attachToWorker(containerId: String, workerIndex: Int) {
        // Since #143, spawn-worker.sh lands each worker in a live herdr pane and
        // records its id in status/worker-<n>.herdr-pane. Prefer bringing that
        // existing pane forward over opening a redundant second attach session
        // in a fresh Warp/Terminal window. Any failure falls through to the
        // Warp/Terminal path below — "never worse than today".
        if focusHerdrPane(workerIndex: workerIndex) {
            return
        }
        let cmd = "docker exec -it \(containerId) tmux attach -t w\(workerIndex)"
        if isWarpAvailable() {
            launchInWarp(command: cmd)
        } else {
            launchInTerminal(command: cmd)
        }
    }

    // MARK: - herdr pane focus

    // Brings the existing herdr pane for this worker into view. Returns true only
    // when the pane was located and focused; any failure returns false so the
    // caller falls back to the Warp/Terminal path.
    private static func focusHerdrPane(workerIndex: Int) -> Bool {
        // 1. herdr must be on PATH (host-only binary; not present on CI etc.).
        guard let herdr = herdrPath() else { return false }

        // 2. The worker must have a recorded pane id. Absent/empty simply means
        //    herdr isn't in play for this worker → Warp/Terminal fallback.
        guard let paneFile = herdrPaneFilePath(workerIndex: workerIndex),
              let paneRaw = try? String(contentsOfFile: paneFile, encoding: .utf8) else {
            return false
        }
        let paneId = paneRaw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !paneId.isEmpty else { return false }

        // 3. Resolve the pane's workspace + tab. `herdr pane get` returns the
        //    standard `.result.…` envelope used throughout bin/herdr-exec.sh.
        guard let paneGet = runHerdr(herdr, ["pane", "get", paneId]),
              paneGet.status == 0,
              let data = paneGet.stdout.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let result = root["result"] as? [String: Any] else {
            return false
        }
        // Decode defensively. `pane get`'s envelope may expose the parent ids as
        // flat fields on a pane object (result.pane.workspace_id / tab_id), or
        // via the nested workspace/tab objects the rest of bin/herdr-exec.sh
        // relies on (result.workspace.workspace_id / result.tab.tab_id). Accept
        // either shape so a nesting difference doesn't silently render this path
        // inert; any failure still returns false → Warp/Terminal fallback.
        let paneObj = (result["pane"] as? [String: Any]) ?? result
        let workspaceId = (paneObj["workspace_id"] as? String)
            ?? ((result["workspace"] as? [String: Any])?["workspace_id"] as? String)
        let tabId = (paneObj["tab_id"] as? String)
            ?? ((result["tab"] as? [String: Any])?["tab_id"] as? String)
        guard let workspaceId, !workspaceId.isEmpty,
              let tabId, !tabId.isEmpty else {
            return false
        }

        // 4. `herdr pane focus` is directional neighbor-focus, not "focus this
        //    specific pane"; workspace+tab focus is the correct combination.
        //    Switch the workspace first — if that fails nothing visible has
        //    changed, so return false for a clean Warp/Terminal fallback.
        guard let wsFocus = runHerdr(herdr, ["workspace", "focus", workspaceId]),
              wsFocus.status == 0 else {
            return false
        }

        // 5. The worker's workspace is now in view. Focus the specific tab
        //    best-effort, but do NOT fall back to opening a window if it fails:
        //    the workspace has already switched, so a redundant attach window on
        //    top of that would be strictly worse than today. The worker's pane
        //    lives in the now-focused workspace regardless, so we're in view.
        _ = runHerdr(herdr, ["tab", "focus", tabId])
        return true
    }

    // Locates the herdr binary on the host. Checks PATH via `which`, then a few
    // common install locations. Returns nil when herdr isn't installed.
    private static func herdrPath() -> String? {
        if let viaWhich = runWhich("herdr") { return viaWhich }
        let candidates = [
            "/opt/homebrew/bin/herdr",
            "/usr/local/bin/herdr",
            "/usr/bin/herdr",
        ]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    // Resolves <repo>/muaddib/status/worker-<n>.herdr-pane relative to the app
    // bundle, walking up exactly as teardownScriptPath() does (bundle →
    // MuaddibApp/ → muaddib/), then into status/ which sits alongside bin/.
    private static func herdrPaneFilePath(workerIndex: Int) -> String? {
        let path = URL(fileURLWithPath: Bundle.main.bundlePath)
            .deletingLastPathComponent()  // MuaddibApp/
            .deletingLastPathComponent()  // muaddib/
            .appendingPathComponent("status/worker-\(workerIndex).herdr-pane")
            .path
        return FileManager.default.fileExists(atPath: path) ? path : nil
    }

    // Runs `herdr <args>` capturing stdout and exit status. Mirrors
    // DockerRunner.run. Returns nil only when the process fails to launch.
    private static func runHerdr(_ herdr: String, _ args: [String]) -> (status: Int32, stdout: String)? {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: herdr)
        proc.arguments = args
        let stdout = Pipe()
        proc.standardOutput = stdout
        proc.standardError = Pipe()
        do {
            try proc.run()
            proc.waitUntilExit()
            let data = stdout.fileHandleForReading.readDataToEndOfFile()
            return (proc.terminationStatus, String(data: data, encoding: .utf8) ?? "")
        } catch {
            return nil
        }
    }

    // Resolves a binary on PATH via `/usr/bin/env which <name>`. Returns nil when
    // it isn't found.
    private static func runWhich(_ name: String) -> String? {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        proc.arguments = ["which", name]
        let stdout = Pipe()
        proc.standardOutput = stdout
        proc.standardError = Pipe()
        do {
            try proc.run()
            proc.waitUntilExit()
            guard proc.terminationStatus == 0 else { return nil }
            let data = stdout.fileHandleForReading.readDataToEndOfFile()
            let path = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return path.isEmpty ? nil : path
        } catch {
            return nil
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

    // Runs teardown-worker.sh <workerIndex> in the background.
    // Blocks the calling thread until the script exits — call from a detached Task.
    static func teardownWorker(workerIndex: Int) {
        guard let script = teardownScriptPath() else { return }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/bash")
        proc.arguments = [script, "\(workerIndex)"]
        proc.standardOutput = Pipe()
        proc.standardError = Pipe()
        try? proc.run()
        proc.waitUntilExit()
    }

    // Locates teardown-worker.sh relative to the app bundle:
    // <repo>/muaddib/MuaddibApp/MuaddibApp.app → <repo>/muaddib/bin/teardown-worker.sh
    private static func teardownScriptPath() -> String? {
        let script = URL(fileURLWithPath: Bundle.main.bundlePath)
            .deletingLastPathComponent()  // MuaddibApp/
            .deletingLastPathComponent()  // muaddib/
            .appendingPathComponent("bin/teardown-worker.sh")
            .path
        return FileManager.default.isExecutableFile(atPath: script) ? script : nil
    }
}

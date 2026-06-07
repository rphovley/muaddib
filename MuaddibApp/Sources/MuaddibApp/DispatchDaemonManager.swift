import Foundation
import Observation

@MainActor
@Observable
final class DispatchDaemonManager {
    private(set) var isRunning = false
    private let cancellable = CancellableTask()

    init() {
        startMonitoring()
        // Auto-start: if the app is running, the dispatcher should be too.
        Task { await autoStartIfNeeded() }
    }

    func toggle() {
        if isRunning { stop() } else { start() }
    }

    private func start() {
        Task {
            let nowRunning = await Task.detached(priority: .userInitiated) {
                DispatchDaemonManager.runDispatchScript("--bg")
                return DockerRunner.isDispatchDaemonRunning()
            }.value
            isRunning = nowRunning
        }
    }

    private func stop() {
        Task {
            let nowRunning = await Task.detached(priority: .userInitiated) {
                DispatchDaemonManager.runDispatchScript("--stop")
                return DockerRunner.isDispatchDaemonRunning()
            }.value
            isRunning = nowRunning
        }
    }

    private func autoStartIfNeeded() async {
        let nowRunning = await Task.detached(priority: .background) {
            guard !DockerRunner.isDispatchDaemonRunning() else { return true }
            DispatchDaemonManager.runDispatchScript("--bg")
            return DockerRunner.isDispatchDaemonRunning()
        }.value
        isRunning = nowRunning
    }

    private func startMonitoring() {
        cancellable.task = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                let running = await Task.detached(priority: .background) {
                    DockerRunner.isDispatchDaemonRunning()
                }.value
                isRunning = running
            }
        }
    }

    // Locates dispatch.sh relative to the app bundle:
    // <repo>/muaddib/MuaddibApp/MuaddibApp.app → <repo>/muaddib/dispatch.sh
    private nonisolated static func dispatchScriptPath() -> String? {
        let script = URL(fileURLWithPath: Bundle.main.bundlePath)
            .deletingLastPathComponent()  // MuaddibApp/
            .deletingLastPathComponent()  // muaddib/
            .appendingPathComponent("dispatch.sh")
            .path
        return FileManager.default.isExecutableFile(atPath: script) ? script : nil
    }

    private nonisolated static func runDispatchScript(_ arg: String) {
        guard let script = dispatchScriptPath() else { return }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/bash")
        proc.arguments = [script, arg]
        proc.standardOutput = Pipe()
        proc.standardError = Pipe()
        try? proc.run()
        proc.waitUntilExit()
    }
}

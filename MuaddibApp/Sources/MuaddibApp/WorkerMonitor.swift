import Foundation
import Observation

@MainActor
@Observable
final class WorkerMonitor {
    private(set) var workers: [WorkerInfo] = []
    private let cancellable = CancellableTask()

    init() {
        startPolling()
    }

    func refresh() {
        Task { await poll() }
    }

    private func poll() async {
        let snapshot = await Task.detached(priority: .background) {
            DockerRunner.fetchWorkers()
        }.value
        workers = snapshot
    }

    private func startPolling() {
        cancellable.task = Task {
            while !Task.isCancelled {
                await poll()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }
}

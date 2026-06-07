import Foundation

// Wraps a Task so deinit can cancel it from a nonisolated context,
// working around the Swift restriction that @MainActor-isolated properties
// cannot be accessed in deinit.
final class CancellableTask {
    var task: Task<Void, Never>?
    deinit { task?.cancel() }
}

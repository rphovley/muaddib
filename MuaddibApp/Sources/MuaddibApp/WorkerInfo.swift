import Foundation

struct WorkerInfo: Identifiable {
    let id: Int
    let containerId: String
    let ticketId: String
    let ticketTitle: String
    let state: String
    let stateTimestamp: String
    let statusDir: String

    var displayLabel: String {
        switch state {
        case "RUNNING":           return "Running"
        case "WATCHING":          return "Watching"
        case "WATCHING_FEEDBACK": return "Reviewing feedback"
        case "BLOCKED":           return "Blocked — needs you"
        case "WAITING_FOR_INPUT": return "Waiting for input"
        case "FAILED":            return "Failed"
        case "DONE":              return "Done"
        case "DONE_FINAL":        return "Done (merged)"
        case "PROVISIONING":      return "Provisioning"
        case "READY":             return "Ready"
        default:                  return state.isEmpty ? "Unknown" : state
        }
    }

    var statusCategory: StatusCategory {
        switch state {
        case "RUNNING", "WATCHING", "WATCHING_FEEDBACK": return .ok
        case "BLOCKED", "WAITING_FOR_INPUT":             return .attention
        case "FAILED":                                   return .error
        default:                                         return .idle
        }
    }

    enum StatusCategory {
        case ok, attention, error, idle
    }
}

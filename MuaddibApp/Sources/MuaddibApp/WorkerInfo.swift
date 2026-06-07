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
        case "FEEDBACK":          return "Awaiting review"
        case "FEEDBACK_WORKING":  return "Fixing feedback"
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
        case "RUNNING", "WATCHING", "FEEDBACK_WORKING", "PROVISIONING": return .ok
        case "WATCHING_FEEDBACK":                                        return .pr
        case "BLOCKED", "WAITING_FOR_INPUT", "FEEDBACK":                 return .attention
        case "FAILED":                                                   return .error
        default:                                                         return .idle
        }
    }

    var elapsedLabel: String {
        guard !stateTimestamp.isEmpty else { return "" }
        let formatter = ISO8601DateFormatter()
        guard let date = formatter.date(from: stateTimestamp) else { return "" }
        let elapsed = Int(-date.timeIntervalSinceNow)
        guard elapsed >= 0 else { return "" }
        if elapsed < 60 { return "\(elapsed)s" }
        if elapsed < 3600 { return "\(elapsed / 60)m" }
        return "\(elapsed / 3600)h"
    }

    var statusGlyph: String {
        switch statusCategory {
        case .ok:        return "play.fill"
        case .pr:        return "arrow.up.doc.fill"
        case .attention: return "bubble.left.fill"
        case .error:     return "xmark.circle.fill"
        case .idle:      return ""
        }
    }

    enum StatusCategory {
        case ok, pr, attention, error, idle
    }
}

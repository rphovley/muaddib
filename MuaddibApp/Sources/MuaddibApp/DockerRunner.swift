import Foundation

enum DockerRunner {
    // Docker Desktop (Intel + Apple Silicon) ships to /usr/local/bin/docker.
    // Homebrew installs to /opt/homebrew/bin/docker on Apple Silicon.
    private static let candidatePaths = [
        "/usr/local/bin/docker",
        "/opt/homebrew/bin/docker",
        "/usr/bin/docker",
    ]

    private static var executablePath: String {
        candidatePaths.first { FileManager.default.isExecutableFile(atPath: $0) }
            ?? candidatePaths[0]
    }

    private static var repoPath: String {
        URL(fileURLWithPath: Bundle.main.bundlePath)
            .deletingLastPathComponent()   // MuaddibApp/
            .deletingLastPathComponent()   // muaddib/
            .deletingLastPathComponent()   // repo root
            .path
    }

    private static var config: MuaddibConfig { MuaddibConfig.load(repoPath: repoPath) }

    private static func run(_ args: [String]) -> String? {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: executablePath)
        proc.arguments = args
        let stdout = Pipe()
        proc.standardOutput = stdout
        proc.standardError = Pipe()
        do {
            try proc.run()
            proc.waitUntilExit()
            guard proc.terminationStatus == 0 else { return nil }
            let data = stdout.fileHandleForReading.readDataToEndOfFile()
            return String(data: data, encoding: .utf8)
        } catch {
            return nil
        }
    }

    // Returns one entry per running worker container whose compose project
    // matches quotethat-wN. Skips db/db_test containers by filtering on the
    // com.docker.compose.service=worker label.
    static func listWorkerContainers() -> [(cid: String, workerIndex: Int, workingDir: String)] {
        guard let raw = run(["ps",
                             "--filter", "label=com.docker.compose.service=worker",
                             "--format", "{{.ID}}"]),
              !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return [] }

        let cids = raw.components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }

        return cids.compactMap { cid -> (cid: String, workerIndex: Int, workingDir: String)? in
            // Read project name and host working directory in one inspect call.
            guard let info = run([
                "inspect", cid, "--format",
                "{{index .Config.Labels \"com.docker.compose.project\"}}|{{index .Config.Labels \"com.docker.compose.project.working_directory\"}}",
            ])?.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }

            let parts = info.components(separatedBy: "|")
            guard parts.count == 2 else { return nil }
            let project = parts[0]
            let workingDir = parts[1]

            // Only consider <projectName>-wN compose projects.
            let projectPrefix = config.projectName
            guard project.range(of: "^\(projectPrefix)-w\\d+$", options: .regularExpression) != nil,
                  let suffix = project.components(separatedBy: "\(projectPrefix)-w").last,
                  let workerIndex = Int(suffix)
            else { return nil }

            return (cid: cid, workerIndex: workerIndex, workingDir: workingDir)
        }
    }

    static func inspectEnv(cid: String) -> [String: String] {
        guard let raw = run(["inspect", cid, "--format",
                             "{{range .Config.Env}}{{println .}}{{end}}"]) else { return [:] }
        var env: [String: String] = [:]
        for line in raw.components(separatedBy: "\n") {
            guard let eq = line.firstIndex(of: "=") else { continue }
            env[String(line[..<eq])] = String(line[line.index(after: eq)...])
        }
        return env
    }

    // Reads /var/run/agent-status/worker-N.state from inside the running container.
    // Format: "STATE ISO-TIMESTAMP\n"
    private static func readContainerState(cid: String, workerIndex: Int) -> (state: String, timestamp: String) {
        let path = "/var/run/agent-status/worker-\(workerIndex).state"
        guard let raw = run(["exec", cid, "cat", path])?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else {
            return ("UNKNOWN", "")
        }
        let parts = raw.components(separatedBy: " ")
        let state = parts.first.flatMap { $0.isEmpty ? nil : $0 } ?? "UNKNOWN"
        return (state, parts.count > 1 ? parts[1] : "")
    }

    static func isDispatchDaemonRunning() -> Bool {
        guard let raw = run(["ps",
                             "--filter", "label=com.docker.compose.project=\(config.projectName)-dispatch",
                             "--format", "{{.ID}}"]) else { return false }
        return !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // Assembles WorkerInfo for every running worker container.
    // Called from a background thread — all operations are synchronous.
    static func fetchWorkers() -> [WorkerInfo] {
        let containers = listWorkerContainers()
        let ticketRegex = try? NSRegularExpression(pattern: "[A-Z]+-\\d+")

        return containers.compactMap { c -> WorkerInfo? in
            let env = inspectEnv(cid: c.cid)
            let task = env["TASK"] ?? ""

            var ticketId = ""
            var ticketTitle = ""
            if let regex = ticketRegex {
                let nsRange = NSRange(task.startIndex..., in: task)
                if let match = regex.firstMatch(in: task, range: nsRange),
                   let swiftRange = Range(match.range, in: task) {
                    ticketId = String(task[swiftRange])
                    // Prefer URL path slug (e.g. "muaddib-easy-access-app"),
                    // fall back to plain text after the ticket ID.
                    if task.hasPrefix("http"),
                       let url = URL(string: task.trimmingCharacters(in: .whitespacesAndNewlines)),
                       let slug = url.pathComponents.last,
                       !slug.lowercased().hasPrefix(ticketId.lowercased()) {
                        ticketTitle = slug.replacingOccurrences(of: "-", with: " ")
                    } else {
                        ticketTitle = String(task[swiftRange.upperBound...])
                            .trimmingCharacters(in: .whitespaces)
                    }
                }
            }

            // Read state from inside the container — avoids host path resolution
            // issues when workers are spawned from the dispatch container and the
            // compose working_directory label holds a container-internal path.
            let statusDir = c.workingDir.isEmpty ? "" : "\(c.workingDir)/status"
            let (state, timestamp) = readContainerState(cid: c.cid, workerIndex: c.workerIndex)

            return WorkerInfo(
                id: c.workerIndex,
                containerId: c.cid,
                ticketId: ticketId,
                ticketTitle: ticketTitle,
                state: state,
                stateTimestamp: timestamp,
                statusDir: statusDir
            )
        }.sorted { $0.id < $1.id }
    }
}

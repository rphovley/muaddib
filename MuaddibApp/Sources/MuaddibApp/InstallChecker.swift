import Foundation
import Observation

@MainActor
@Observable
final class InstallChecker {
    private(set) var items: [CheckItem] = []
    private(set) var isRunning = false

    struct CheckItem: Identifiable, Sendable {
        enum Status: Sendable { case ok, warning, failed }
        let id: String
        let label: String
        let status: Status
        let hint: String
    }

    var hasFailure: Bool {
        items.contains { $0.status == .failed }
    }

    init() {
        Task { await run() }
    }

    func run() async {
        isRunning = true
        items = []
        let result = await Task.detached(priority: .userInitiated) {
            InstallChecker.performChecks()
        }.value
        items = result
        isRunning = false
    }

    // MARK: - Helpers (nonisolated — called from detached background task)

    nonisolated static func muaddibDir() -> URL {
        URL(fileURLWithPath: Bundle.main.bundlePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private nonisolated static func toolPath(_ name: String) -> String? {
        ["/usr/local/bin/\(name)", "/opt/homebrew/bin/\(name)", "/usr/bin/\(name)"]
            .first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    private nonisolated static func runExitCode(executable: String, args: [String]) -> Int32 {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: executable)
        proc.arguments = args
        proc.standardOutput = Pipe()
        proc.standardError = Pipe()
        do {
            try proc.run()
            proc.waitUntilExit()
        } catch {
            return -1
        }
        return proc.terminationStatus
    }

    private nonisolated static func parseEnvFile(at url: URL) -> [String: String] {
        guard let contents = try? String(contentsOf: url, encoding: .utf8) else { return [:] }
        var env: [String: String] = [:]
        for line in contents.components(separatedBy: "\n") {
            let stripped = line.trimmingCharacters(in: .whitespaces)
            guard !stripped.isEmpty, !stripped.hasPrefix("#"),
                  let eq = stripped.firstIndex(of: "=") else { continue }
            let key = String(stripped[..<eq])
            var value = String(stripped[stripped.index(after: eq)...])
            if (value.hasPrefix("\"") && value.hasSuffix("\"")) ||
               (value.hasPrefix("'") && value.hasSuffix("'")) {
                value = String(value.dropFirst().dropLast())
            }
            env[key] = value
        }
        return env
    }

    private nonisolated static func isPlaceholder(_ value: String?) -> Bool {
        guard let v = value, !v.isEmpty else { return true }
        return v.hasPrefix("your_") || v.hasPrefix("YOUR_")
            || v.lowercased() == "changeme"
            || v.uppercased().contains("PLACEHOLDER")
    }

    // MARK: - Check runner

    private nonisolated static func performChecks() -> [CheckItem] {
        var result: [CheckItem] = []

        // 1. docker CLI
        let dockerPath = toolPath("docker")
        result.append(CheckItem(
            id: "docker",
            label: "docker CLI",
            status: dockerPath != nil ? .ok : .failed,
            hint: dockerPath != nil ? "" : "Install Docker Desktop from docker.com"
        ))
        let resolvedDocker = dockerPath ?? "/usr/local/bin/docker"

        // 2. node
        let nodeOk = toolPath("node") != nil
        result.append(CheckItem(
            id: "node",
            label: "node",
            status: nodeOk ? .ok : .failed,
            hint: nodeOk ? "" : "Install Node.js from nodejs.org or via Homebrew"
        ))

        // 3. gh
        let ghOk = toolPath("gh") != nil
        result.append(CheckItem(
            id: "gh",
            label: "gh (GitHub CLI)",
            status: ghOk ? .ok : .failed,
            hint: ghOk ? "" : "brew install gh"
        ))

        // 4. claude — only ships to /usr/local/bin or Homebrew
        let claudeOk = ["/usr/local/bin/claude", "/opt/homebrew/bin/claude"]
            .contains { FileManager.default.isExecutableFile(atPath: $0) }
        result.append(CheckItem(
            id: "claude",
            label: "claude CLI",
            status: claudeOk ? .ok : .failed,
            hint: claudeOk ? "" : "npm install -g @anthropic-ai/claude-code"
        ))

        // 5. cloudflared (optional — warning only)
        let cfOk = toolPath("cloudflared") != nil
        result.append(CheckItem(
            id: "cloudflared",
            label: "cloudflared (optional)",
            status: cfOk ? .ok : .warning,
            hint: cfOk ? "" : "brew install cloudflared — needed for tunnel support"
        ))

        // 6. Docker daemon
        let daemonOk = runExitCode(executable: resolvedDocker, args: ["info"]) == 0
        result.append(CheckItem(
            id: "docker-daemon",
            label: "Docker daemon",
            status: daemonOk ? .ok : .failed,
            hint: daemonOk ? "" : "Open Docker Desktop and wait for it to start"
        ))

        // 7. CLAUDE_CODE_OAUTH_TOKEN (shell-exported)
        let procEnv = ProcessInfo.processInfo.environment
        let hasClaudeToken = !(procEnv["CLAUDE_CODE_OAUTH_TOKEN"] ?? "").isEmpty
        result.append(CheckItem(
            id: "claude-token",
            label: "CLAUDE_CODE_OAUTH_TOKEN",
            status: hasClaudeToken ? .ok : .failed,
            hint: hasClaudeToken ? "" : "Set in your shell profile and relaunch muaddib"
        ))

        // 8. GITHUB_TOKEN (shell-exported)
        let hasGithubToken = !(procEnv["GITHUB_TOKEN"] ?? "").isEmpty
        result.append(CheckItem(
            id: "github-token",
            label: "GITHUB_TOKEN",
            status: hasGithubToken ? .ok : .failed,
            hint: hasGithubToken ? "" : "Set in your shell profile and relaunch muaddib"
        ))

        // 9. non-prod.env exists
        let envFile = muaddibDir().appendingPathComponent("non-prod.env")
        let envFileExists = FileManager.default.fileExists(atPath: envFile.path)
        result.append(CheckItem(
            id: "env-file",
            label: "non-prod.env",
            status: envFileExists ? .ok : .failed,
            hint: envFileExists ? "" : "Copy non-prod.env.example to non-prod.env and fill in values"
        ))

        let envVars = envFileExists ? parseEnvFile(at: envFile) : [:]

        // 10. LINEAR_API_KEY
        let linearKeyOk = !isPlaceholder(envVars["LINEAR_API_KEY"])
        result.append(CheckItem(
            id: "linear-api-key",
            label: "LINEAR_API_KEY",
            status: linearKeyOk ? .ok : .failed,
            hint: linearKeyOk ? "" : "Set LINEAR_API_KEY in non-prod.env"
        ))

        // 11. LINEAR_TEAM_ID
        let linearTeamOk = !isPlaceholder(envVars["LINEAR_TEAM_ID"])
        result.append(CheckItem(
            id: "linear-team-id",
            label: "LINEAR_TEAM_ID",
            status: linearTeamOk ? .ok : .failed,
            hint: linearTeamOk ? "" : "Set LINEAR_TEAM_ID in non-prod.env"
        ))

        // 12. DISPATCH_WEBHOOK_SECRET
        let webhookOk = !isPlaceholder(envVars["DISPATCH_WEBHOOK_SECRET"])
        result.append(CheckItem(
            id: "dispatch-secret",
            label: "DISPATCH_WEBHOOK_SECRET",
            status: webhookOk ? .ok : .failed,
            hint: webhookOk ? "" : "Set DISPATCH_WEBHOOK_SECRET in non-prod.env"
        ))

        // 13. quotethat-worker:latest image
        let imageOk = runExitCode(executable: resolvedDocker, args: ["image", "inspect", "quotethat-worker:latest"]) == 0
        result.append(CheckItem(
            id: "worker-image",
            label: "quotethat-worker:latest",
            status: imageOk ? .ok : .failed,
            hint: imageOk ? "" : "Run install.sh to build the worker image"
        ))

        return result
    }
}

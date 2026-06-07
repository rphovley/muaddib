import Foundation

final class LinearService {
    private let apiKey: String

    private static let graphqlEndpoint = URL(string: "https://api.linear.app/graphql")!

    struct LabelInfo {
        let id: String
        let name: String
    }

    enum LinearError: LocalizedError {
        case missingApiKey
        case missingTeamId
        case networkError(String)
        case parseError(String)

        var errorDescription: String? {
            switch self {
            case .missingApiKey:
                return "LINEAR_API_KEY not found in non-prod.env or environment"
            case .missingTeamId:
                return "LINEAR_TEAM_ID not found in non-prod.env or environment"
            case .networkError(let msg):
                return "Network error: \(msg)"
            case .parseError(let msg):
                return "Parse error: \(msg)"
            }
        }
    }

    init(apiKey: String) {
        self.apiKey = apiKey
    }

    static func make() throws -> LinearService {
        guard let key = readEnvVar("LINEAR_API_KEY") else {
            throw LinearError.missingApiKey
        }
        return LinearService(apiKey: key)
    }

    // Reads a key from non-prod.env (relative to app bundle), then falls back to
    // the process environment. Mirrors the path-resolution pattern used by
    // DispatchDaemonManager.dispatchScriptPath().
    static func readEnvVar(_ key: String) -> String? {
        if let fileValue = readFromEnvFile(key: key) {
            return fileValue
        }
        return ProcessInfo.processInfo.environment[key]
    }

    private static func readFromEnvFile(key: String) -> String? {
        let envPath = URL(fileURLWithPath: Bundle.main.bundlePath)
            .deletingLastPathComponent()  // MuaddibApp/
            .deletingLastPathComponent()  // muaddib/
            .appendingPathComponent("non-prod.env")
            .path
        guard let contents = try? String(contentsOfFile: envPath, encoding: .utf8) else {
            return nil
        }
        for line in contents.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty, !trimmed.hasPrefix("#") else { continue }
            let parts = trimmed.split(separator: "=", maxSplits: 1).map(String.init)
            guard parts.count == 2, parts[0] == key else { continue }
            return parts[1].trimmingCharacters(in: .whitespaces)
        }
        return nil
    }

    func fetchLabels(teamId: String) async throws -> [LabelInfo] {
        let query = """
        query FetchLabels($teamId: String!) {
          team(id: $teamId) {
            labels {
              nodes {
                id
                name
              }
            }
          }
        }
        """
        let response = try await graphql(query: query, variables: ["teamId": teamId])

        guard let data = response["data"] as? [String: Any],
              let team = data["team"] as? [String: Any],
              let labels = team["labels"] as? [String: Any],
              let nodes = labels["nodes"] as? [[String: Any]] else {
            throw LinearError.parseError("Unexpected labels response structure")
        }

        return nodes.compactMap { node -> LabelInfo? in
            guard let id = node["id"] as? String,
                  let name = node["name"] as? String else { return nil }
            return LabelInfo(id: id, name: name)
        }
    }

    func createIssue(
        title: String,
        description: String?,
        labelIds: [String],
        teamId: String
    ) async throws -> String {
        let mutation = """
        mutation CreateIssue($title: String!, $description: String, $labelIds: [String!], $teamId: String!) {
          issueCreate(input: {
            title: $title,
            description: $description,
            labelIds: $labelIds,
            teamId: $teamId
          }) {
            success
            issue {
              id
              url
            }
          }
        }
        """
        var variables: [String: Any] = [
            "title": title,
            "teamId": teamId,
        ]
        if let desc = description {
            variables["description"] = desc
        }
        if !labelIds.isEmpty {
            variables["labelIds"] = labelIds
        }
        let response = try await graphql(query: mutation, variables: variables)

        guard let data = response["data"] as? [String: Any],
              let issueCreate = data["issueCreate"] as? [String: Any],
              let issue = issueCreate["issue"] as? [String: Any],
              let url = issue["url"] as? String else {
            throw LinearError.parseError("Unexpected issueCreate response structure")
        }
        return url
    }

    // Uploads a file via Linear's fileUpload mutation → S3 PUT, returning the CDN URL.
    func uploadFile(data: Data, filename: String, contentType: String) async throws -> String {
        let mutation = """
        mutation FileUpload($filename: String!, $contentType: String!, $size: Int!) {
          fileUpload(filename: $filename, contentType: $contentType, size: $size) {
            success
            uploadFile {
              filename
              uploadUrl
              assetUrl
              headers {
                key
                value
              }
            }
          }
        }
        """
        let variables: [String: Any] = [
            "filename": filename,
            "contentType": contentType,
            "size": data.count,
        ]
        let response = try await graphql(query: mutation, variables: variables)

        guard let respData = response["data"] as? [String: Any],
              let fileUpload = respData["fileUpload"] as? [String: Any],
              let uploadFile = fileUpload["uploadFile"] as? [String: Any],
              let uploadUrl = uploadFile["uploadUrl"] as? String,
              let assetUrl = uploadFile["assetUrl"] as? String else {
            throw LinearError.parseError("Unexpected fileUpload response structure")
        }

        let rawHeaders = uploadFile["headers"] as? [[String: Any]] ?? []
        var s3Request = URLRequest(url: URL(string: uploadUrl)!)
        s3Request.httpMethod = "PUT"
        s3Request.httpBody = data
        s3Request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        for header in rawHeaders {
            if let key = header["key"] as? String, let value = header["value"] as? String {
                s3Request.setValue(value, forHTTPHeaderField: key)
            }
        }

        let (_, s3Response) = try await URLSession.shared.data(for: s3Request)
        guard let http = s3Response as? HTTPURLResponse, http.statusCode < 300 else {
            let code = (s3Response as? HTTPURLResponse)?.statusCode ?? -1
            throw LinearError.networkError("S3 upload failed with status \(code)")
        }

        return assetUrl
    }

    private func graphql(query: String, variables: [String: Any]) async throws -> [String: Any] {
        var request = URLRequest(url: LinearService.graphqlEndpoint)
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["query": query, "variables": variables])

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let code = (response as? HTTPURLResponse)?.statusCode ?? -1
            let body = String(data: data, encoding: .utf8).map { ": \($0.prefix(300))" } ?? ""
            throw LinearError.networkError("HTTP \(code)\(body)")
        }
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw LinearError.parseError("Response is not a JSON object")
        }
        if let errors = json["errors"] as? [[String: Any]],
           let first = errors.first,
           let message = first["message"] as? String {
            throw LinearError.networkError(message)
        }
        return json
    }
}

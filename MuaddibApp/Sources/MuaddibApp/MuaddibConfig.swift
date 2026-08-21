import Foundation

struct MuaddibConfig: Codable {
    struct Project: Codable {
        let name: String
        let path: String
    }
    let projectName: String
    let projects: [Project]

    // Returns nil (not a "quotethat"-shaped guess) if .muaddib/manifest.json is
    // missing or invalid — callers decide what a missing config means for them.
    static func load(repoPath: String) -> MuaddibConfig? {
        let url = URL(fileURLWithPath: repoPath)
            .appendingPathComponent(".muaddib")
            .appendingPathComponent("manifest.json")
        guard let data = try? Data(contentsOf: url),
              let config = try? JSONDecoder().decode(MuaddibConfig.self, from: data)
        else { return nil }
        return config
    }
}

import Foundation

struct MuaddibConfig: Codable {
    struct Project: Codable {
        let name: String
        let path: String
    }
    let projectName: String
    let projects: [Project]

    static func load(repoPath: String) -> MuaddibConfig {
        let url = URL(fileURLWithPath: repoPath).appendingPathComponent(".muaddib.json")
        guard let data = try? Data(contentsOf: url),
              let config = try? JSONDecoder().decode(MuaddibConfig.self, from: data)
        else { return MuaddibConfig(projectName: "quotethat", projects: []) }
        return config
    }
}

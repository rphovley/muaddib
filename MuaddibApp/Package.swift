// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MuaddibApp",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "MuaddibApp",
            path: "Sources/MuaddibApp"
        ),
    ]
)

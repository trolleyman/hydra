// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "HydraDesktop",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "HydraDesktop", targets: ["HydraDesktop"]),
    ],
    targets: [
        .executableTarget(name: "HydraDesktop"),
    ]
)

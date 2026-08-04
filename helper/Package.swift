// swift-tools-version: 6.2
import Foundation
import PackageDescription

// swift-testing (`import Testing`, used by speech-helperTests) ships as
// `Testing.framework`, but under a Command Line Tools-only install (no full
// Xcode.app) it is not on the default search/runtime-load path: `swift test`
// fails to compile ("no such module 'Testing'"), and once that's fixed,
// fails at load time ("Library not loaded: @rpath/Testing.framework/...",
// then the same again for `lib_TestingInterop.dylib`). Verified directly on
// the machine this was fixed on (Command Line Tools only — `xcodebuild
// -version` fails with "requires Xcode, but active developer directory ...
// is a command line tools instance"). A full Xcode.app install is
// unaffected (its swiftpm wiring already resolves these paths on its own),
// so flags are only ever added for directories that actually exist on this
// machine — nothing changes for a toolchain where the framework is already
// found normally.
func swiftTestingSearchDirectories() -> (frameworks: String, lib: String)? {
    var developerDirs: [String] = []
    if let devDir = ProcessInfo.processInfo.environment["DEVELOPER_DIR"], !devDir.isEmpty {
        developerDirs.append(devDir)
    }
    developerDirs.append("/Library/Developer/CommandLineTools")

    for devDir in developerDirs {
        let frameworks = devDir + "/Library/Developer/Frameworks"
        let lib = devDir + "/Library/Developer/usr/lib"
        if FileManager.default.fileExists(atPath: frameworks + "/Testing.framework") {
            return (frameworks: frameworks, lib: lib)
        }
    }
    return nil
}

let swiftTestingPaths = swiftTestingSearchDirectories()

let speechHelperTestsSwiftSettings: [SwiftSetting] =
    swiftTestingPaths.map { paths in
        [.unsafeFlags(["-F", paths.frameworks])]
    } ?? []

let speechHelperTestsLinkerSettings: [LinkerSetting] =
    swiftTestingPaths.map { paths in
        [
            .unsafeFlags([
                "-F", paths.frameworks,
                "-Xlinker", "-rpath", "-Xlinker", paths.frameworks,
                "-Xlinker", "-rpath", "-Xlinker", paths.lib,
            ])
        ]
    } ?? []

let package = Package(
    name: "speech-helper",
    platforms: [
        .macOS(.v26)
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-argument-parser", from: "1.5.0"),
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.15.5")
    ],
    targets: [
        .executableTarget(
            name: "speech-helper",
            dependencies: [
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
                .product(name: "FluidAudio", package: "FluidAudio")
            ]
        ),
        .testTarget(
            name: "speech-helperTests",
            dependencies: ["speech-helper"],
            swiftSettings: speechHelperTestsSwiftSettings,
            linkerSettings: speechHelperTestsLinkerSettings
        )
    ]
)

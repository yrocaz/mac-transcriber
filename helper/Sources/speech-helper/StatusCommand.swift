import ArgumentParser
import Foundation
import Speech

/// `speech-helper status` — backs `GET /health` (spec §2): reports whether
/// `SpeechTranscriber` is available on this machine plus its supported and
/// installed locale lists, as a single line of JSON on stdout.
struct StatusCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "status",
        abstract: "Print SpeechTranscriber availability and locale info as JSON."
    )

    func run() async throws {
        let available = SpeechTranscriber.isAvailable
        let supportedLocales = await SpeechTranscriber.supportedLocales
            .map { $0.identifier(.bcp47) }
            .sorted()
        let installedLocales = await SpeechTranscriber.installedLocales
            .map { $0.identifier(.bcp47) }
            .sorted()

        let payload: [String: Any] = [
            "available": available,
            "supportedLocales": supportedLocales,
            "installedLocales": installedLocales,
        ]

        guard
            let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        else {
            throw ExitCode.failure
        }
        var line = data
        line.append(0x0A)
        FileHandle.standardOutput.write(line)
    }
}

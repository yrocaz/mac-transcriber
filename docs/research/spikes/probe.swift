import Foundation
import Speech

@main
struct Probe {
    static func main() async {
        if #available(macOS 26, *) {
            let supported = await SpeechTranscriber.supportedLocales
            let installed = await SpeechTranscriber.installedLocales
            print("SpeechTranscriber available: yes")
            print("Supported locales (\(supported.count)):")
            print(supported.map(\.identifier).sorted().joined(separator: ", "))
            print("\nInstalled locales (\(installed.count)):")
            print(installed.map(\.identifier).sorted().joined(separator: ", "))
        } else {
            print("SpeechAnalyzer requires macOS 26+")
        }
    }
}

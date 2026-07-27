import Foundation
import Speech
import AVFoundation

@main
struct Transcribe {
    static func main() async {
        guard #available(macOS 26, *) else { return }
        do {
            let url = URL(fileURLWithPath: CommandLine.arguments[1])
            let transcriber = SpeechTranscriber(locale: Locale(identifier: "en_US"),
                                                transcriptionOptions: [],
                                                reportingOptions: [],
                                                attributeOptions: [.audioTimeRange])
            let analyzer = SpeechAnalyzer(modules: [transcriber])
            let audioFile = try AVAudioFile(forReading: url)
            let start = Date()
            if let lastSample = try await analyzer.analyzeSequence(from: audioFile) {
                try await analyzer.finalizeAndFinish(through: lastSample)
            }
            var text = ""
            for try await result in transcriber.results where result.isFinal {
                text += String(result.text.characters)
            }
            let elapsed = Date().timeIntervalSince(start)
            print("Transcript: \(text)")
            print(String(format: "Elapsed: %.2fs", elapsed))
        } catch {
            print("Error: \(error)")
        }
    }
}

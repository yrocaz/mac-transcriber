import ArgumentParser

/// Root command for the `speech-helper` executable (spec §4). Two
/// subcommands: `status` (backs `GET /health`) and `transcribe` (the
/// transcription core; diarization arrives in Task 2).
@main
struct SpeechHelper: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "speech-helper",
        abstract: "Local Apple SpeechAnalyzer wrapper — spawned by the media-transcriber server per job.",
        subcommands: [StatusCommand.self, TranscribeCommand.self]
    )
}

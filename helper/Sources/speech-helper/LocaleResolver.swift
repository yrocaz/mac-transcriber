import Foundation
import Speech

/// Normalizes a user-supplied locale identifier (e.g. `en_US`, `en-US`) to one
/// of `SpeechTranscriber`'s actual supported `Locale` values, comparing by
/// BCP-47 identifier rather than `Locale` equality. Per official Apple
/// engineer guidance (forum 790108): "arbitrary locales such as `Locale.current`
/// or `Locale(identifier: "en_US")` may not [work], because the exact equality
/// of locales differ depending on how they were created" — the underscore-vs-
/// hyphen mismatch is the classic footgun this avoids.
enum LocaleResolver {
    static func resolve(_ identifier: String) async throws -> Locale {
        let requested = Locale(identifier: identifier)

        if let equivalent = await SpeechTranscriber.supportedLocale(equivalentTo: requested) {
            return equivalent
        }

        // Fall back to a direct BCP-47 comparison against the supported list,
        // in case supportedLocale(equivalentTo:) itself declines an otherwise
        // valid identifier.
        let supportedLocales = await SpeechTranscriber.supportedLocales
        if let match = supportedLocales.first(where: {
            $0.identifier(.bcp47) == requested.identifier(.bcp47)
        }) {
            return match
        }

        let available = supportedLocales.map { $0.identifier(.bcp47) }.sorted().joined(
            separator: ", ")
        throw HelperError(
            code: "cannotAllocateUnsupportedLocale",
            message:
                "Locale \"\(identifier)\" is not supported for speech transcription. Supported locales: \(available)"
        )
    }
}

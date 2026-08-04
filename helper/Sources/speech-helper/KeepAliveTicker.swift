import Foundation

/// Emits a periodic no-op-progress keepalive tick while a genuinely silent
/// operation is in flight — spec §6's inactivity timeout (120s, server-side)
/// only resets on *any* stdout NDJSON event, and FluidAudio's diarization
/// model download/`prepareModels()` window (unlike Apple's AssetInventory
/// path, which is KVO-driven and reports `model_download` progress on its
/// own) emits nothing at all until its own `process(audio:progressCallback:)`
/// starts reporting real chunks. Without a keepalive, that silent window can
/// exceed the inactivity budget on a slow/first-run connection and kill an
/// otherwise-healthy job (spec §6 review Finding, Critical 1).
///
/// Built on `DispatchSourceTimer` on its own dedicated serial queue rather
/// than `Task.sleep` on the cooperative thread pool: the window this covers
/// includes `DiarizationAudioDecoder.decode()`, which is fully synchronous
/// with no suspension points and occupies a cooperative-pool thread for its
/// entire duration. A `Task.sleep`-based ticker competing for that same pool
/// could itself be starved for the exact stretch it exists to paper over — a
/// dispatch timer on an independent queue has no such dependency.
final class KeepAliveTicker: @unchecked Sendable {
    private let queue = DispatchQueue(label: "speech-helper.keepalive-ticker")
    private let intervalSec: Double
    private let onTick: @Sendable () -> Void
    private var source: DispatchSourceTimer?
    private var stopped = false

    init(intervalSec: Double, onTick: @escaping @Sendable () -> Void) {
        self.intervalSec = intervalSec
        self.onTick = onTick
    }

    /// Starts the periodic loop (first tick after `intervalSec`, then every
    /// `intervalSec` thereafter). Safe to call once; a second call is a
    /// no-op. Ticks stop firing immediately once `stop()` has been called —
    /// checked on the same serial queue the timer fires on, so there is no
    /// window where a tick can be "in flight" past a `stop()` call.
    func start() {
        queue.sync {
            guard source == nil, !stopped else { return }
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now() + intervalSec, repeating: intervalSec)
            timer.setEventHandler { [weak self] in
                guard let self, !self.stopped else { return }
                self.onTick()
            }
            source = timer
            timer.resume()
        }
    }

    /// Cancels the loop. Safe to call multiple times, before `start()`, or
    /// concurrently with an in-flight tick (the in-flight tick's own
    /// `stopped` check, evaluated on the same serial queue, is what
    /// guarantees no tick fires after this returns in practice).
    func stop() {
        queue.sync {
            stopped = true
            source?.cancel()
            source = nil
        }
    }
}

import Foundation
import Capacitor
import UserNotifications
import AVFoundation
import AudioToolbox

/// iOS counterpart of the Android TimerService.
/// iOS won't keep an app running in the background, so every upcoming cue is
/// pre-scheduled as a local notification with its sound (plays on the lock screen).
/// While the app is open, cues are played directly instead (audible even in silent mode).
/// Same JS API as Android: window.Capacitor.Plugins.RepeatTimer
@objc(TimerPlugin)
public class TimerPlugin: CAPPlugin, CAPBridgedPlugin, UNUserNotificationCenterDelegate {
    public let identifier = "TimerPlugin"
    public let jsName = "RepeatTimer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restartRound", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "playCue", returnType: CAPPluginReturnPromise),
    ]

    /// iOS allows 64 pending notifications per app; keep headroom.
    private let maxScheduled = 60
    private let stateKey = "repeatTimerState"

    private var state = "idle"          // idle | work | rest | done
    private var phaseEnd: Double = 0    // wall clock ms when current phase ends
    private var round = 0
    private var durationMs: Double = 180_000
    private var restMs: Double = 5_000
    private var repeatOn = false
    private var sound = true
    private var vibrate = true
    private var soundType = "bowl"
    private var player: AVAudioPlayer?

    private var running: Bool { state == "work" || state == "rest" }
    private func now() -> Double { Date().timeIntervalSince1970 * 1000 }

    override public func load() {
        // Mix with music; .playback means in-app cues are heard even with the silent switch on.
        try? AVAudioSession.sharedInstance().setCategory(.playback, options: [.mixWithOthers])
        installSounds()
        UNUserNotificationCenter.current().delegate = self
        restoreState()
    }

    // MARK: - JS API

    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.durationMs = call.getDouble("durationMs") ?? 180_000
            self.restMs = call.getDouble("restMs") ?? 5_000
            self.repeatOn = call.getBool("repeat") ?? false
            self.sound = call.getBool("sound") ?? true
            self.vibrate = call.getBool("vibrate") ?? true
            self.soundType = call.getString("soundType") ?? "bowl"
            let leadIn = (call.getBool("leadIn") ?? false) && self.restMs > 0
            self.round = leadIn ? 0 : 1
            self.state = leadIn ? "rest" : "work"
            self.phaseEnd = call.getDouble("phaseEnd") ?? (self.now() + (leadIn ? self.restMs : self.durationMs))
            if leadIn { self.buzz() } else { self.cue("start") }
            self.saveState()
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in
                DispatchQueue.main.async { self.schedule() }
            }
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.state = "idle"
            self.round = 0
            UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
            self.saveState()
            self.notifyListeners("state", data: self.snapshot(), retainUntilConsumed: true)
            call.resolve()
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.repeatOn = call.getBool("repeat") ?? self.repeatOn
            self.restMs = call.getDouble("restMs") ?? self.restMs
            self.sound = call.getBool("sound") ?? self.sound
            self.vibrate = call.getBool("vibrate") ?? self.vibrate
            self.soundType = call.getString("soundType") ?? self.soundType
            if self.running { self.catchUp(); self.schedule() }
            self.saveState()
            call.resolve()
        }
    }

    @objc func restartRound(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if self.state == "work" {
                self.phaseEnd = call.getDouble("phaseEnd") ?? (self.now() + self.durationMs)
                self.cue("start")
                self.schedule()
                self.saveState()
            }
            call.resolve()
        }
    }

    @objc func getState(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.catchUp()
            self.saveState()
            call.resolve(self.snapshot())
        }
    }

    @objc func playCue(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.play(type: call.getString("soundType") ?? self.soundType, kind: call.getString("kind") ?? "end")
            call.resolve()
        }
    }

    // MARK: - State machine (same rules as www/app.js and the Android service)

    private struct Phase { var state: String; var phaseEnd: Double; var round: Int }

    private func step(_ p: inout Phase) -> String? {
        if p.state == "work" {
            if !repeatOn { p.state = "done"; return "end" }
            if restMs > 0 { p.state = "rest"; p.phaseEnd += restMs }
            else { p.round += 1; p.phaseEnd += durationMs }
            return "end"
        }
        if p.state == "rest" {
            p.state = "work"; p.round += 1; p.phaseEnd += durationMs
            return "resume"
        }
        return nil
    }

    private func catchUp() {
        var p = Phase(state: state, phaseEnd: phaseEnd, round: round)
        let t = now()
        while (p.state == "work" || p.state == "rest") && t >= p.phaseEnd { _ = step(&p) }
        state = p.state; phaseEnd = p.phaseEnd; round = p.round
    }

    /// Replace all pending cue notifications with the next `maxScheduled` cues.
    private func schedule() {
        let center = UNUserNotificationCenter.current()
        center.removeAllPendingNotificationRequests()
        guard running else { return }
        var p = Phase(state: state, phaseEnd: phaseEnd, round: round)
        let t0 = now()
        var i = 0
        while (p.state == "work" || p.state == "rest") && i < maxScheduled {
            let at = p.phaseEnd
            guard let kind = step(&p) else { break }
            if at <= t0 { continue }
            let content = UNMutableNotificationContent()
            switch p.state {
            case "done": content.title = "Done"; content.body = "Timer finished."
            case "rest": content.title = "Rest"; content.body = "Round \(p.round) complete."
            default:
                content.title = repeatOn ? "Round \(p.round)" : "Go"
                content.body = kind == "resume" ? "Rest over — next round." : "Round complete — next round."
            }
            content.userInfo = ["kind": kind]
            if sound {
                content.sound = UNNotificationSound(named: UNNotificationSoundName("\(soundType)_\(kind).wav"))
            }
            if #available(iOS 15.0, *) { content.interruptionLevel = .active }
            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: max(0.5, (at - t0) / 1000), repeats: false)
            center.add(UNNotificationRequest(identifier: "cue-\(i)", content: content, trigger: trigger))
            i += 1
        }
    }

    // MARK: - Foreground: play cues ourselves, no banner

    public func userNotificationCenter(_ center: UNUserNotificationCenter,
                                       willPresent notification: UNNotification,
                                       withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let req = notification.request
        if req.identifier.hasPrefix("cue-"), let kind = req.content.userInfo["kind"] as? String {
            cue(kind)
            completionHandler([])
        } else {
            completionHandler([.banner, .sound])
        }
    }

    // MARK: - Sound & vibration

    private func cue(_ kind: String) {
        if sound { play(type: soundType, kind: kind) }
        buzz()
    }

    private func buzz() {
        if vibrate { AudioServicesPlaySystemSound(kSystemSoundID_Vibrate) }
    }

    private var soundsDir: URL {
        FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0].appendingPathComponent("Sounds")
    }

    private func play(type: String, kind: String) {
        let url = soundsDir.appendingPathComponent("\(type)_\(kind).wav")
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        try? AVAudioSession.sharedInstance().setActive(true)
        player = try? AVAudioPlayer(contentsOf: url)
        player?.play()
    }

    /// Notification sounds must live in Library/Sounds (or the bundle root);
    /// copy them there from the web assets (www/sounds → public/sounds).
    private func installSounds() {
        let fm = FileManager.default
        guard let src = Bundle.main.url(forResource: "sounds", withExtension: nil, subdirectory: "public") else { return }
        try? fm.createDirectory(at: soundsDir, withIntermediateDirectories: true)
        for f in (try? fm.contentsOfDirectory(at: src, includingPropertiesForKeys: nil)) ?? [] where f.pathExtension == "wav" {
            let dst = soundsDir.appendingPathComponent(f.lastPathComponent)
            try? fm.removeItem(at: dst)
            try? fm.copyItem(at: f, to: dst)
        }
    }

    // MARK: - Persistence (survives the app being closed while notifications keep firing)

    private func snapshot() -> [String: Any] {
        ["state": state, "phaseEnd": phaseEnd, "round": round]
    }

    private func saveState() {
        UserDefaults.standard.set([
            "state": state, "phaseEnd": phaseEnd, "round": round,
            "durationMs": durationMs, "restMs": restMs, "repeat": repeatOn,
            "sound": sound, "vibrate": vibrate, "soundType": soundType,
        ] as [String: Any], forKey: stateKey)
    }

    private func restoreState() {
        guard let d = UserDefaults.standard.dictionary(forKey: stateKey) else { return }
        state = d["state"] as? String ?? "idle"
        phaseEnd = d["phaseEnd"] as? Double ?? 0
        round = d["round"] as? Int ?? 0
        durationMs = d["durationMs"] as? Double ?? 180_000
        restMs = d["restMs"] as? Double ?? 5_000
        repeatOn = d["repeat"] as? Bool ?? false
        sound = d["sound"] as? Bool ?? true
        vibrate = d["vibrate"] as? Bool ?? true
        soundType = d["soundType"] as? String ?? "bowl"
    }
}

import WidgetKit
import SwiftUI

/// Lock Screen / Home Screen countdown.
/// The app is suspended while the screen is locked, so TimerPlugin writes the upcoming
/// phases to the shared App Group up front and WidgetKit switches entries at each phase end.
struct PhaseEntry: TimelineEntry {
    let date: Date
    let label: String
    let end: Date?      // nil = not running: show the duration as plain text
    let rest: Bool
    let idleText: String
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> PhaseEntry {
        PhaseEntry(date: Date(), label: "", end: nil, rest: false, idleText: "3:00")
    }

    func getSnapshot(in context: Context, completion: @escaping (PhaseEntry) -> Void) {
        completion(entries()[0])
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<PhaseEntry>) -> Void) {
        completion(Timeline(entries: entries(), policy: .never)) // TimerPlugin reloads on every change
    }

    /// One entry per upcoming phase, then a stopped entry after the last one.
    private func entries() -> [PhaseEntry] {
        let d = UserDefaults(suiteName: "group.com.texitservicesllc.repeattimer")?.dictionary(forKey: "widget") ?? [:]
        let repeatOn = d["repeat"] as? Bool ?? false
        let secs = Int((d["durationMs"] as? Double ?? 180_000) / 1000)
        let idle = String(format: "%d:%02d", secs / 60, secs % 60)
        let now = Date()
        var out: [PhaseEntry] = []
        var lastEnd = now
        for ph in d["phases"] as? [[String: Any]] ?? [] {
            let end = Date(timeIntervalSince1970: (ph["end"] as? Double ?? 0) / 1000)
            guard end > now else { continue }
            let start = Date(timeIntervalSince1970: (ph["start"] as? Double ?? 0) / 1000)
            let state = ph["state"] as? String ?? "work"
            let round = ph["round"] as? Int ?? 1
            let label = state == "rest" ? (round == 0 ? "Get ready" : "Resting") : (repeatOn ? "Round \(round)" : "Timer")
            out.append(PhaseEntry(date: max(start, now), label: label, end: end, rest: state == "rest", idleText: idle))
            lastEnd = end
        }
        let done = (d["after"] as? String) == "done"
        out.append(PhaseEntry(date: lastEnd, label: done ? "Done" : "", end: nil, rest: false, idleText: idle))
        return out
    }
}

struct TimerWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: PhaseEntry

    var body: some View {
        let lockScreen = family == .accessoryRectangular
        VStack(alignment: lockScreen ? .leading : .center, spacing: 0) {
            if !entry.label.isEmpty {
                Text(entry.label)
                    .font(.headline)
                    .foregroundStyle(lockScreen ? AnyShapeStyle(.secondary) : AnyShapeStyle(Color.gray))
            }
            Group {
                if let end = entry.end {
                    Text(timerInterval: entry.date...end, countsDown: true)
                } else {
                    Text(entry.idleText)
                }
            }
            .font(.system(size: lockScreen ? 34 : 52, weight: .bold).monospacedDigit())
            .multilineTextAlignment(lockScreen ? .leading : .center)
            .lineLimit(1)
            .minimumScaleFactor(0.5)
            // Same amber as the app's rest phase; the Lock Screen tints everything itself.
            .foregroundStyle(lockScreen ? AnyShapeStyle(.primary)
                             : AnyShapeStyle(entry.rest ? Color(red: 0.95, green: 0.70, blue: 0.20) : .white))
        }
        .frame(maxWidth: .infinity, alignment: lockScreen ? .leading : .center)
        .containerBackground(for: .widget) { lockScreen ? Color.clear : Color.black }
    }
}

@main
struct TimerWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "TimerWidget", provider: Provider()) { TimerWidgetView(entry: $0) }
            .configurationDisplayName("Yoga & Egg Timer")
            .description("Shows the countdown, round and rest while the timer runs.")
            .supportedFamilies([.accessoryRectangular, .systemSmall])
    }
}

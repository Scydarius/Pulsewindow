import Combine
import Foundation
import UserNotifications

struct PulseReading: Identifiable, Codable, Hashable {
    let id: UUID
    let date: Date
    let bpm: Double
    let context: String

    init(id: UUID = UUID(), date: Date = Date(), bpm: Double, context: String = "Routine check") {
        self.id = id
        self.date = date
        self.bpm = bpm
        self.context = context
    }

    private enum CodingKeys: String, CodingKey { case id, date, bpm, context }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(UUID.self, forKey: .id)
        date = try values.decode(Date.self, forKey: .date)
        bpm = try values.decode(Double.self, forKey: .bpm)
        context = try values.decodeIfPresent(String.self, forKey: .context) ?? "Routine check"
    }
}

struct Medication: Identifiable, Codable, Hashable {
    let id: UUID
    var name: String
    var dose: String
    var usualTime: Date
    var checkPlan: Int
    var doseChangeMode: Bool
    var monitoringFrequency: String?
    var formulation: String?
    var checkTiming: String?
    var checkOffsetMinutes: [Int]?

    init(
        id: UUID = UUID(),
        name: String,
        dose: String,
        usualTime: Date,
        checkPlan: Int = 2,
        doseChangeMode: Bool = false,
        monitoringFrequency: String? = nil,
        formulation: String? = nil,
        checkTiming: String? = nil,
        checkOffsetMinutes: [Int]? = nil
    ) {
        self.id = id
        self.name = name
        self.dose = dose
        self.usualTime = usualTime
        self.checkPlan = checkPlan
        self.doseChangeMode = doseChangeMode
        self.monitoringFrequency = monitoringFrequency
        self.formulation = formulation
        self.checkTiming = checkTiming
        self.checkOffsetMinutes = checkOffsetMinutes
    }
}

struct DoseEvent: Identifiable, Codable, Hashable {
    let id: UUID
    let medicationID: UUID
    let medicationName: String
    let date: Date

    init(id: UUID = UUID(), medication: Medication, date: Date = Date()) {
        self.id = id
        medicationID = medication.id
        medicationName = medication.name
        self.date = date
    }
}

@MainActor
final class ReadingStore: ObservableObject {
    @Published private(set) var readings: [PulseReading] = []
    @Published private(set) var medications: [Medication] = []
    @Published private(set) var doses: [DoseEvent] = []

    private let readingsKey = "pulse-window-native-readings"
    private let medicationsKey = "pulse-window-medications"
    private let dosesKey = "pulse-window-dose-events"

    init() {
        readings = load([PulseReading].self, key: readingsKey).sorted { $0.date < $1.date }
        medications = load([Medication].self, key: medicationsKey).map { medication in
            guard let preset = MedicationPreset.matching(medicineName: medication.name)
            else { return medication }
            var upgraded = medication
            upgraded.monitoringFrequency = preset.monitoringFrequency
            upgraded.formulation = preset.formulation
            upgraded.checkTiming = preset.schedule
            upgraded.checkOffsetMinutes = medication.doseChangeMode
                ? preset.changeOffsets
                : preset.routineOffsets
            return upgraded
        }
        doses = load([DoseEvent].self, key: dosesKey).sorted { $0.date < $1.date }
        persist(medications, key: medicationsKey)
        medications.forEach { scheduleReminders(for: $0) }
    }

    var nextMedication: Medication? {
        medications.min { nextDoseDate(for: $0) < nextDoseDate(for: $1) }
    }

    func nextDoseDate(for medication: Medication, from now: Date = Date()) -> Date {
        let calendar = Calendar.current
        let components = calendar.dateComponents([.hour, .minute], from: medication.usualTime)
        let today = calendar.date(bySettingHour: components.hour ?? 9,
                                  minute: components.minute ?? 0,
                                  second: 0, of: now) ?? now
        return today > now ? today : calendar.date(byAdding: .day, value: 1, to: today) ?? today
    }

    func checkTimeSummary(for medication: Medication) -> String {
        let offsets = medication.checkOffsetMinutes ?? checkOffsets(for: medication.checkPlan)
        return offsets.compactMap {
            Calendar.current.date(byAdding: .minute, value: $0, to: medication.usualTime)
        }
        .map { $0.formatted(date: .omitted, time: .shortened) }
        .joined(separator: ", ")
    }

    @discardableResult
    func save(bpm: Double) -> PulseReading {
        let now = Date()
        let reading = PulseReading(
            date: now,
            bpm: bpm.rounded(toPlaces: 1),
            context: readingContext(at: now)
        )
        readings.append(reading)
        readings.sort { $0.date < $1.date }
        persist(readings, key: readingsKey)
        return reading
    }

    func addMedication(
        name: String,
        dose: String,
        time: Date,
        checks: Int,
        doseChange: Bool,
        monitoringFrequency: String? = nil,
        formulation: String? = nil,
        checkTiming: String? = nil,
        checkOffsets: [Int]? = nil
    ) {
        let medication = Medication(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            dose: dose.trimmingCharacters(in: .whitespacesAndNewlines),
            usualTime: time,
            checkPlan: checks,
            doseChangeMode: doseChange,
            monitoringFrequency: monitoringFrequency,
            formulation: formulation,
            checkTiming: checkTiming,
            checkOffsetMinutes: checkOffsets
        )
        medications.append(medication)
        persist(medications, key: medicationsKey)
        scheduleReminders(for: medication)
    }

    func deleteMedication(_ medication: Medication) {
        medications.removeAll { $0.id == medication.id }
        persist(medications, key: medicationsKey)
        UNUserNotificationCenter.current().removePendingNotificationRequests(
            withIdentifiers: reminderIDs(for: medication)
        )
    }

    func logDose(_ medication: Medication, at date: Date = Date()) {
        doses.append(DoseEvent(medication: medication, date: date))
        doses.sort { $0.date < $1.date }
        persist(doses, key: dosesKey)
    }

    func deleteReading(at offsets: IndexSet) {
        let newestFirst = readings.sorted { $0.date > $1.date }
        let ids = offsets.map { newestFirst[$0].id }
        readings.removeAll { ids.contains($0.id) }
        persist(readings, key: readingsKey)
    }

    var exportText: String {
        var rows = [
            "PulseWindow monitoring summary",
            "Wellness estimates only — not a medical record or diagnosis.",
            "",
            "PULSE MEASUREMENTS",
            "Date,Time,BPM,Context",
        ]
        let day = DateFormatter(); day.dateFormat = "yyyy-MM-dd"
        let time = DateFormatter(); time.dateFormat = "HH:mm"
        rows += readings.map { "\(day.string(from: $0.date)),\(time.string(from: $0.date)),\($0.bpm),\($0.context)" }
        rows += ["", "DOSES TAKEN", "Date,Time,Medication"]
        rows += doses.map { "\(day.string(from: $0.date)),\(time.string(from: $0.date)),\($0.medicationName)" }
        return rows.joined(separator: "\n")
    }

    private func readingContext(at date: Date) -> String {
        guard let dose = doses.min(by: {
            abs($0.date.timeIntervalSince(date)) < abs($1.date.timeIntervalSince(date))
        }) else { return "Routine check" }
        let hours = date.timeIntervalSince(dose.date) / 3600
        guard abs(hours) <= 12 else { return "Routine check" }
        if hours >= 0 { return String(format: "%.1f h after %@", hours, dose.medicationName) }
        return String(format: "%.1f h before %@", abs(hours), dose.medicationName)
    }

    private func scheduleReminders(for medication: Medication) {
        let offsets = medication.checkOffsetMinutes ?? checkOffsets(for: medication.checkPlan)
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            let center = UNUserNotificationCenter.current()
            let calendar = Calendar.current
            let doseComponents = calendar.dateComponents([.hour, .minute], from: medication.usualTime)

            let doseContent = UNMutableNotificationContent()
            doseContent.title = "Medication check-in"
            doseContent.body = "If you took \(medication.name), log the dose in PulseWindow."
            doseContent.sound = .default
            center.add(UNNotificationRequest(
                identifier: "dose-\(medication.id)",
                content: doseContent,
                trigger: UNCalendarNotificationTrigger(dateMatching: doseComponents, repeats: true)
            ))

            for (index, offset) in offsets.enumerated() {
                guard let reminderTime = calendar.date(byAdding: .minute, value: offset,
                                                       to: medication.usualTime) else { continue }
                let content = UNMutableNotificationContent()
                content.title = "Pulse check"
                content.body = "\(Self.reminderTiming(for: offset)) for \(medication.name). Use the plan confirmed by your clinician."
                content.sound = .default
                let components = calendar.dateComponents([.hour, .minute], from: reminderTime)
                center.add(UNNotificationRequest(
                    identifier: "check-\(medication.id)-\(index)",
                    content: content,
                    trigger: UNCalendarNotificationTrigger(dateMatching: components, repeats: true)
                ))
            }
        }
    }

    private func checkOffsets(for count: Int) -> [Int] {
        switch count {
        case 4...: return [-60, 120, 300, 480]
        case 3: return [-60, 240, 480]
        case 2: return [-60, 480]
        default: return [0]
        }
    }

    nonisolated private static func reminderTiming(for offset: Int) -> String {
        if offset == 0 { return "Time for your planned resting pulse check" }
        let minutes = abs(offset)
        let amount: String
        if minutes.isMultiple(of: 60) {
            let hours = minutes / 60
            amount = "\(hours) hour\(hours == 1 ? "" : "s")"
        } else {
            amount = "\(minutes) minutes"
        }
        return offset < 0
            ? "Time for your planned pulse check \(amount) before the dose"
            : "Time for your planned pulse check \(amount) after the dose"
    }

    private func reminderIDs(for medication: Medication) -> [String] {
        ["dose-\(medication.id)"] + (0..<8).map { "check-\(medication.id)-\($0)" }
    }

    private func load<T: Decodable>(_ type: [T].Type, key: String) -> [T] {
        guard let data = UserDefaults.standard.data(forKey: key),
              let saved = try? JSONDecoder().decode(type, from: data) else { return [] }
        return saved
    }

    private func persist<T: Encodable>(_ value: T, key: String) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }
}

private extension Double {
    func rounded(toPlaces places: Int) -> Double {
        let divisor = pow(10, Double(places))
        return (self * divisor).rounded() / divisor
    }
}

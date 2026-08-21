import Charts
import PhotosUI
import SwiftUI
import UIKit

struct MedicationPreset: Identifiable, Hashable {
    let id: String
    let name: String
    let routineChecks: Int
    let changeChecks: Int
    let monitoringFrequency: String
    let formulation: String
    let schedule: String
    let routineOffsets: [Int]
    let changeOffsets: [Int]

    static let all = [
        MedicationPreset(id: "sotalol", name: "Sotalol", routineChecks: 2, changeChecks: 3,
                         monitoringFrequency: "2 pulse checks each day",
                         formulation: "Standard tablet (not slow release)",
                         schedule: "Resting check just before a dose and about 3 hours after it. Product information reports peak levels at 2.5–4 hours.",
                         routineOffsets: [-15, 180], changeOffsets: [-15, 180, 480]),
        MedicationPreset(id: "beta-blocker", name: "Beta blocker", routineChecks: 1, changeChecks: 1,
                         monitoringFrequency: "Timing must be set after the exact medicine is entered",
                         formulation: "Exact drug and immediate/slow-release form required",
                         schedule: "There is no safe generic after-dose time for the whole class. Extended-release metoprolol has a steadier effect across 24 hours.",
                         routineOffsets: [0], changeOffsets: [0]),
        MedicationPreset(id: "amiodarone", name: "Amiodarone", routineChecks: 1, changeChecks: 1,
                         monitoringFrequency: "1 pulse check each day at the same resting time",
                         formulation: "Long-acting tablet; timing is not linked to one dose",
                         schedule: "Check at the same resting time each day. Loading-dose monitoring must be set by the treating clinician and may require ECG review.",
                         routineOffsets: [0], changeOffsets: [0]),
        MedicationPreset(id: "digoxin", name: "Digoxin", routineChecks: 1, changeChecks: 1,
                         monitoringFrequency: "1 pulse check each day",
                         formulation: "Standard tablet",
                         schedule: "For a clinician-requested post-dose response check, the reference window is 2–6 hours; this template uses 4 hours.",
                         routineOffsets: [240], changeOffsets: [240]),
        MedicationPreset(id: "clonidine-ir", name: "Clonidine (immediate release)", routineChecks: 2, changeChecks: 2,
                         monitoringFrequency: "2 pulse checks each day",
                         formulation: "Immediate-release tablet",
                         schedule: "Resting check just before the dose and about 2 hours after it; peak levels are usually reached in 1–3 hours.",
                         routineOffsets: [-15, 120], changeOffsets: [-15, 120]),
        MedicationPreset(id: "clonidine-er", name: "Clonidine (extended release)", routineChecks: 1, changeChecks: 1,
                         monitoringFrequency: "1 pulse check each day at a clinician-confirmed time",
                         formulation: "Extended/slow-release tablet",
                         schedule: "Absorption is delayed. Do not reuse immediate-release timing; this template leaves the check at the clinician-set time.",
                         routineOffsets: [0], changeOffsets: [0]),
        MedicationPreset(id: "ivabradine", name: "Ivabradine", routineChecks: 2, changeChecks: 2,
                         monitoringFrequency: "2 pulse checks each day",
                         formulation: "Standard tablet taken with food",
                         schedule: "Resting check just before a dose and about 2 hours after it; food delays peak concentration by about 1 hour.",
                         routineOffsets: [-15, 120], changeOffsets: [-15, 120]),
    ]

    static func matching(medicineName: String) -> MedicationPreset? {
        let name = medicineName.lowercased()
        if name.contains("sotalol") { return all.first { $0.id == "sotalol" } }
        if name.contains("amiodarone") { return all.first { $0.id == "amiodarone" } }
        if name.contains("digoxin") { return all.first { $0.id == "digoxin" } }
        if name.contains("ivabradine") { return all.first { $0.id == "ivabradine" } }
        if name.contains("clonidine") {
            let id = name.contains("extended") || name.contains("slow") ? "clonidine-er" : "clonidine-ir"
            return all.first { $0.id == id }
        }
        if name.contains("beta blocker") || name.contains("beta-blocker") {
            return all.first { $0.id == "beta-blocker" }
        }
        return nil
    }
}

struct ContentView: View {
    var body: some View {
        TabView {
            NavigationStack { DashboardView() }
                .tabItem { Label("Today", systemImage: "house.fill") }
            NavigationStack { MedicationsView() }
                .tabItem { Label("Medicines", systemImage: "pill.fill") }
            NavigationStack { HistoryView() }
                .tabItem { Label("History", systemImage: "chart.xyaxis.line") }
        }
        .tint(.pulseGreen)
        .preferredColorScheme(.light)
    }
}

private struct DashboardView: View {
    @EnvironmentObject private var monitor: CameraPulseMonitor
    @EnvironmentObject private var store: ReadingStore

    private var latest: PulseReading? { store.readings.last }
    private var nextCheck: (medication: Medication, date: Date)? { store.nextPulseCheck() }
    @State private var doseMessage: String?

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                HStack(spacing: 14) {
                    Image("PulseWindowLogo")
                        .resizable().scaledToFit()
                        .frame(width: 66, height: 66)
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                    VStack(alignment: .leading, spacing: 3) {
                        Text("PULSE WINDOW")
                            .font(.caption.bold()).tracking(1.8)
                            .foregroundStyle(Color.pulseGreen)
                        Text("Today")
                            .font(.system(size: 34, weight: .bold, design: .rounded))
                            .foregroundStyle(Color.pulseInk)
                    }
                    Spacer()
                }

                HStack(spacing: 12) {
                    MetricCard(value: latest.map { "\(Int($0.bpm.rounded()))" } ?? "—",
                               label: "Latest BPM", icon: "heart.fill", colour: .pulseRed)
                    MetricCard(value: "\(store.medications.count)", label: "Medicines",
                               icon: "pill.fill", colour: .pulseGreen)
                }

                VStack(alignment: .leading, spacing: 5) {
                    Text("Your next step")
                        .font(.title2.bold()).foregroundStyle(Color.pulseInk)
                    Text("PulseWindow puts the next planned action first.")
                        .font(.body).foregroundStyle(Color.pulseMuted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                if let nextCheck {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack(spacing: 12) {
                            Image(systemName: "heart.text.square.fill")
                                .font(.system(size: 34)).foregroundStyle(Color.pulseRed)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(nextCheck.date <= Date().addingTimeInterval(15 * 60) ? "DUE NOW" : "NEXT MEASUREMENT")
                                    .font(.caption.bold()).tracking(1.2).foregroundStyle(Color.pulseRed)
                                Text("Pulse check for \(nextCheck.medication.name)")
                                    .font(.title2.bold()).foregroundStyle(Color.pulseInk)
                                Text(nextCheck.date, format: .dateTime.weekday(.wide).hour().minute())
                                    .font(.headline).foregroundStyle(Color.pulseGreen)
                            }
                            Spacer()
                        }
                        Text("This time comes from the medication plan entered in PulseWindow. Follow your clinician or pharmacist’s instructions.")
                            .font(.subheadline).foregroundStyle(Color.pulseMuted)
                        NavigationLink { MonitorView() } label: {
                            Label("Start measurement", systemImage: "waveform.path.ecg")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(PrimaryButtonStyle())
                    }
                    .padding(19)
                    .background(Color.white, in: RoundedRectangle(cornerRadius: 22))
                    .overlay(RoundedRectangle(cornerRadius: 22).stroke(Color.pulseRed.opacity(0.25), lineWidth: 2))
                }

                HStack(spacing: 12) {
                    Image(systemName: store.notificationsEnabled ? "bell.badge.fill" : "bell.slash.fill")
                        .font(.title2).foregroundStyle(Color.pulseGreen)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Measurement reminders").font(.headline).foregroundStyle(Color.pulseInk)
                        Text(store.notificationStatus).font(.subheadline).foregroundStyle(Color.pulseMuted)
                    }
                    Spacer()
                    if !store.notificationsEnabled {
                        Button("Turn on") { store.enableNotifications() }
                            .font(.subheadline.bold()).foregroundStyle(Color.white)
                            .padding(.horizontal, 15).frame(minHeight: 44)
                            .background(Color.pulseGreen, in: Capsule())
                    } else {
                        Label("On", systemImage: "checkmark.circle.fill")
                            .font(.subheadline.bold()).foregroundStyle(Color.pulseGreen)
                    }
                }
                .cardStyle()

                VStack(alignment: .leading, spacing: 14) {
                    Label("Next medication", systemImage: "clock.fill")
                        .font(.headline).foregroundStyle(Color.pulseInk)
                    if let medication = store.nextMedication {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(medication.name).font(.title3.bold()).foregroundStyle(Color.pulseInk)
                            Text(medication.dose.isEmpty ? "Dose not entered" : medication.dose)
                                .foregroundStyle(Color.pulseMuted)
                            Text(store.nextDoseDate(for: medication), style: .time)
                                .font(.title2.bold()).foregroundStyle(Color.pulseGreen)
                        }
                        Text("Log the dose when it is actually taken so pulse readings can be shown before and after it.")
                            .font(.subheadline).foregroundStyle(Color.pulseMuted)
                        if let frequency = medication.monitoringFrequency {
                            Label(frequency, systemImage: "waveform.path.ecg")
                                .font(.body.bold()).foregroundStyle(Color.pulseGreen)
                        }
                        Label("Pulse reminders: \(store.checkTimeSummary(for: medication))", systemImage: "bell.fill")
                            .font(.subheadline.bold()).foregroundStyle(Color.pulseInk)
                        if let timing = medication.checkTiming {
                            Text("Suggested pulse-check timing: \(timing)")
                                .font(.subheadline).foregroundStyle(Color.pulseMuted)
                        }
                        Button {
                            store.logDose(medication)
                            doseMessage = "Dose recorded for \(medication.name) at \(Date().formatted(date: .omitted, time: .shortened))."
                        } label: {
                            Label("Log \(medication.name) as taken", systemImage: "checkmark.circle.fill")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(SecondaryButtonStyle())
                        if let doseMessage {
                            Label(doseMessage, systemImage: "checkmark.circle.fill")
                                .font(.subheadline.bold()).foregroundStyle(Color.pulseGreen)
                        }
                    } else {
                        Text("Add a medicine to plan dose and pulse-check reminders.")
                            .foregroundStyle(Color.pulseMuted)
                        NavigationLink("Add a medicine") { MedicationsView() }
                            .font(.headline).foregroundStyle(Color.pulseGreen)
                    }
                }
                .cardStyle()

                VStack(alignment: .leading, spacing: 14) {
                    Label("Camera pulse check", systemImage: "camera.fill")
                        .font(.headline).foregroundStyle(Color.pulseInk)
                    Text("Sit still in steady front lighting. Calibration takes 15 seconds, then the app confirms a stable estimate.")
                        .foregroundStyle(Color.pulseMuted)

                    if monitor.cameras.isEmpty {
                        Text("No cameras found").foregroundStyle(Color.pulseMuted)
                    } else {
                        Picker("Camera", selection: $monitor.selectedCameraID) {
                            ForEach(monitor.cameras) { camera in
                                Text(camera.name).tag(camera.id)
                            }
                        }
                        .pickerStyle(.menu)
                        .tint(.pulseGreen)
                        .padding(.horizontal, 12).frame(minHeight: 48)
                        .background(Color.pulseSoft, in: RoundedRectangle(cornerRadius: 13))
                        .onChange(of: monitor.selectedCameraID) { _, id in monitor.selectCamera(id) }
                    }

                    NavigationLink {
                        MonitorView()
                    } label: {
                        Label("Start pulse measurement", systemImage: "waveform.path.ecg")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(PrimaryButtonStyle())
                }
                .cardStyle()

                Text("PulseWindow is a wellness prototype. Medication schedules and check times must follow instructions from your clinician or pharmacist.")
                    .font(.footnote).foregroundStyle(Color.pulseMuted)
                    .multilineTextAlignment(.center).padding(.horizontal, 8)
            }
            .padding(18)
        }
        .background(Color.pulseBackground.ignoresSafeArea())
        .navigationBarHidden(true)
        .onAppear { monitor.refreshCameras() }
    }
}

private struct MedicationsView: View {
    @EnvironmentObject private var store: ReadingStore
    @State private var showingAdd = false
    @State private var medicationToDelete: Medication?
    @State private var doseMessage: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Medicines")
                        .font(.system(size: 36, weight: .bold, design: .rounded))
                        .foregroundStyle(Color.pulseInk)
                    Text("Keep dose times and planned pulse checks together.")
                        .foregroundStyle(Color.pulseMuted)
                }

                Button { showingAdd = true } label: {
                    Label("Add medicine", systemImage: "plus.circle.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(PrimaryButtonStyle())

                if store.medications.isEmpty {
                    EmptyCard(icon: "pill", title: "No medicines yet",
                              message: "Add only medicines and schedules provided by your healthcare professional.")
                } else {
                    ForEach(store.medications) { medication in
                        VStack(alignment: .leading, spacing: 12) {
                            HStack(alignment: .top) {
                                Group {
                                    if let data = medication.photoData, let image = UIImage(data: data) {
                                        Image(uiImage: image).resizable().scaledToFill()
                                    } else {
                                        Image(systemName: "pill.fill").resizable().scaledToFit().padding(18)
                                            .foregroundStyle(Color.pulseGreen)
                                            .background(Color.pulseSoft)
                                    }
                                }
                                .frame(width: 76, height: 76)
                                .clipShape(RoundedRectangle(cornerRadius: 14))
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(medication.name).font(.title3.bold()).foregroundStyle(Color.pulseInk)
                                    if let ingredient = medication.activeIngredient {
                                        Text("Active ingredient: \(ingredient)")
                                            .font(.subheadline.bold()).foregroundStyle(Color.pulseInk)
                                    }
                                    if medication.brand != nil || medication.manufacturer != nil {
                                        Text([medication.brand, medication.manufacturer].compactMap { $0 }.joined(separator: " · "))
                                            .font(.subheadline).foregroundStyle(Color.pulseMuted)
                                    }
                                    Text(medication.dose.isEmpty ? "Dose not entered" : medication.dose)
                                        .foregroundStyle(Color.pulseMuted)
                                }
                                Spacer()
                                Text(medication.usualTime, style: .time)
                                    .font(.headline).foregroundStyle(Color.pulseGreen)
                            }
                            Label("\(medication.checkPlan) planned pulse check\(medication.checkPlan == 1 ? "" : "s") daily",
                                  systemImage: "waveform.path.ecg")
                                .foregroundStyle(Color.pulseMuted)
                            if let frequency = medication.monitoringFrequency {
                                Label(frequency, systemImage: "calendar.badge.clock")
                                    .font(.body.bold()).foregroundStyle(Color.pulseGreen)
                            }
                            Label("Reminder times: \(store.checkTimeSummary(for: medication))", systemImage: "bell.fill")
                                .font(.body.bold()).foregroundStyle(Color.pulseInk)
                            if let formulation = medication.formulation {
                                Label(formulation, systemImage: "capsule")
                                    .foregroundStyle(Color.pulseMuted)
                            }
                            if let timing = medication.checkTiming {
                                Text("Suggested pulse-check timing: \(timing)")
                                    .font(.body).foregroundStyle(Color.pulseInk)
                            }
                            if let directions = medication.prescribedDirections {
                                Label(directions, systemImage: "doc.text.fill")
                                    .foregroundStyle(Color.pulseInk)
                            }
                            if let purpose = medication.purpose {
                                Text("Used for: \(purpose)").foregroundStyle(Color.pulseMuted)
                            }
                            if let prescriber = medication.prescriber {
                                Text("Prescriber: \(prescriber)").foregroundStyle(Color.pulseMuted)
                            }
                            if medication.doseChangeMode {
                                Label("Dose-change monitoring enabled", systemImage: "arrow.triangle.2.circlepath")
                                    .font(.subheadline.bold()).foregroundStyle(Color.pulseOrange)
                            }
                            Button {
                                store.logDose(medication)
                                doseMessage = "Dose recorded for \(medication.name)."
                            } label: {
                                Label("Log dose as taken", systemImage: "checkmark.circle.fill")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(SecondaryButtonStyle())
                            Button(role: .destructive) { medicationToDelete = medication } label: {
                                Label("Remove medicine", systemImage: "trash")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                            .tint(.pulseRed)
                            .controlSize(.large)
                            .frame(minHeight: 52)
                        }
                        .cardStyle()
                    }
                }

                if let doseMessage {
                    Label(doseMessage, systemImage: "checkmark.circle.fill")
                        .font(.body.bold()).foregroundStyle(Color.pulseGreen)
                        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.pulseGreen.opacity(0.10), in: RoundedRectangle(cornerRadius: 14))
                }

                VStack(alignment: .leading, spacing: 12) {
                    Text("Monitoring reference list").font(.title3.bold()).foregroundStyle(Color.pulseInk)
                    Text("These are templates, not instructions. Use one only if it matches the plan given by your clinician or pharmacist.")
                        .font(.body).foregroundStyle(Color.pulseMuted)
                    ForEach(MedicationPreset.all) { preset in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(preset.name).font(.headline).foregroundStyle(Color.pulseGreen)
                            Text(preset.monitoringFrequency).font(.body.bold()).foregroundStyle(Color.pulseInk)
                            Text(preset.formulation).font(.body).foregroundStyle(Color.pulseMuted)
                            Text(preset.schedule).font(.body).foregroundStyle(Color.pulseMuted)
                        }
                        .padding(.vertical, 3)
                        if preset.id != MedicationPreset.all.last?.id { Divider() }
                    }
                }
                .cardStyle()

                Text("Reminders support your existing care plan; they do not recommend when or how often to take medication.")
                    .font(.footnote).foregroundStyle(Color.pulseMuted)
            }
            .padding(18)
        }
        .background(Color.pulseBackground.ignoresSafeArea())
        .navigationTitle("Medicines")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showingAdd) { AddMedicationView() }
        .alert("Remove medicine?", isPresented: Binding(
            get: { medicationToDelete != nil },
            set: { if !$0 { medicationToDelete = nil } }
        )) {
            Button("Cancel", role: .cancel) { medicationToDelete = nil }
            Button("Remove", role: .destructive) {
                if let medicationToDelete { store.deleteMedication(medicationToDelete) }
                medicationToDelete = nil
            }
        } message: {
            Text("This removes the medicine and its future reminders. Saved pulse readings will remain.")
        }
    }
}

private struct AddMedicationView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: ReadingStore
    @State private var name = ""
    @State private var activeIngredient = ""
    @State private var brand = ""
    @State private var manufacturer = ""
    @State private var dose = ""
    @State private var directions = ""
    @State private var purpose = ""
    @State private var prescriber = ""
    @State private var startDate = Date()
    @State private var includeStartDate = false
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var photoData: Data?
    @State private var time = Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: Date()) ?? Date()
    @State private var customCheckTime = Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: Date()) ?? Date()
    @State private var checks = 1
    @State private var doseChange = false
    @State private var selectedPresetID = "custom"

    private var selectedPreset: MedicationPreset? {
        MedicationPreset.all.first { $0.id == selectedPresetID }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Medicine") {
                    Picker("Monitoring template", selection: $selectedPresetID) {
                        Text("Custom").tag("custom")
                        ForEach(MedicationPreset.all) { preset in Text(preset.name).tag(preset.id) }
                    }
                    .onChange(of: selectedPresetID) { _, _ in applyPreset() }
                    TextField("Name on the pack", text: $name)
                    TextField("Active ingredient", text: $activeIngredient)
                    TextField("Brand", text: $brand)
                    TextField("Manufacturer (for example Sandoz)", text: $manufacturer)
                    TextField("Strength or dose", text: $dose)
                    TextField("Directions on pharmacy label", text: $directions, axis: .vertical)
                    TextField("What it is for", text: $purpose)
                    TextField("Prescriber", text: $prescriber)
                    Toggle("Record start date", isOn: $includeStartDate)
                    if includeStartDate { DatePicker("Started", selection: $startDate, displayedComponents: .date) }
                    DatePicker("Usual dose time", selection: $time, displayedComponents: .hourAndMinute)
                }
                Section("Photo of medicine") {
                    if let photoData, let image = UIImage(data: photoData) {
                        Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 220)
                            .clipShape(RoundedRectangle(cornerRadius: 16))
                    }
                    PhotosPicker(selection: $selectedPhoto, matching: .images) {
                        Label(photoData == nil ? "Take or choose a photo" : "Replace photo", systemImage: "camera.fill")
                    }
                    .onChange(of: selectedPhoto) { _, item in
                        Task {
                            guard let data = try? await item?.loadTransferable(type: Data.self),
                                  let image = UIImage(data: data) else { return }
                            photoData = image.jpegData(compressionQuality: 0.70)
                        }
                    }
                    Text("A clear pack or tablet photo helps distinguish brands and generic manufacturers. Confirm the medicine name from its pharmacy label.")
                        .font(.footnote).foregroundStyle(Color.pulseMuted)
                }
                Section("Pulse check plan") {
                    if selectedPreset == nil {
                        DatePicker("Daily measurement time confirmed by clinician",
                                   selection: $customCheckTime, displayedComponents: .hourAndMinute)
                    } else {
                        LabeledContent("Planned checks", value: "\(checks) each day")
                    }
                    Toggle("Dose-change or loading-dose monitoring", isOn: $doseChange)
                        .onChange(of: doseChange) { _, _ in applyCheckCount() }
                    if let selectedPreset {
                        Text(selectedPreset.monitoringFrequency).font(.body.bold()).foregroundStyle(Color.pulseGreen)
                        Text(selectedPreset.formulation).font(.body).foregroundStyle(Color.pulseMuted)
                        Text(selectedPreset.schedule).font(.body).foregroundStyle(Color.pulseInk)
                    }
                    Label("Reminder times: \(reminderPreview)", systemImage: "bell.fill")
                        .font(.body.bold()).foregroundStyle(Color.pulseGreen)
                    Text("These are pulse-check reminders, not instructions for taking medicine. Turn on extra monitoring only when your clinician requested it.")
                        .font(.footnote).foregroundStyle(Color.pulseMuted)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.pulseBackground)
            .navigationTitle("Add medicine")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        store.addMedication(
                            name: name, activeIngredient: activeIngredient, brand: brand,
                            manufacturer: manufacturer, dose: dose, directions: directions,
                            purpose: purpose, prescriber: prescriber,
                            startDate: includeStartDate ? startDate : nil, photoData: photoData, time: time,
                            checks: checks, doseChange: doseChange,
                            monitoringFrequency: selectedPreset?.monitoringFrequency,
                            formulation: selectedPreset?.formulation,
                            checkTiming: selectedPreset?.schedule,
                            checkOffsets: selectedPreset == nil ? nil : plannedOffsets,
                            checkTimes: selectedPreset == nil ? [customCheckTime] : nil
                        )
                        dismiss()
                    }
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .preferredColorScheme(.light)
    }

    private func applyPreset() {
        guard let preset = selectedPreset else { return }
        name = preset.name
        doseChange = false
        checks = preset.routineChecks
    }

    private func applyCheckCount() {
        guard let preset = selectedPreset else { return }
        checks = doseChange ? preset.changeChecks : preset.routineChecks
    }

    private var plannedOffsets: [Int] {
        if let selectedPreset {
            return doseChange ? selectedPreset.changeOffsets : selectedPreset.routineOffsets
        }
        switch checks {
        case 4...: return [-60, 120, 300, 480]
        case 3: return [-60, 240, 480]
        case 2: return [-60, 480]
        default: return [0]
        }
    }

    private var reminderPreview: String {
        if selectedPreset == nil {
            return customCheckTime.formatted(date: .omitted, time: .shortened)
        }
        return plannedOffsets.compactMap {
            Calendar.current.date(byAdding: .minute, value: $0, to: time)
        }
        .map { $0.formatted(date: .omitted, time: .shortened) }
        .joined(separator: ", ")
    }
}

private struct MonitorView: View {
    @EnvironmentObject private var monitor: CameraPulseMonitor
    @EnvironmentObject private var store: ReadingStore
    @State private var saveMessage: String?

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                ZStack(alignment: .bottom) {
                    CameraPreview(session: monitor.session, faceBox: monitor.faceBox,
                                  mirrored: monitor.isFrontCamera, frameSize: monitor.videoFrameSize)
                        .overlay { if monitor.developerMode { Color.green.opacity(0.28).blendMode(.color) } }
                    if monitor.developerMode { GreenWaveformView(samples: monitor.greenWaveform).padding(12) }
                }
                .frame(height: 430).background(Color.black)
                .clipShape(RoundedRectangle(cornerRadius: 24))

                VStack(spacing: 14) {
                    HStack(spacing: 16) {
                        PulsingHeart(bpm: monitor.bpm, active: monitor.isMonitoring)
                        Text(monitor.bpm.map { String(Int($0.rounded())) } ?? "—")
                            .font(.system(size: 54, weight: .bold, design: .rounded))
                            .monospacedDigit().foregroundStyle(Color.pulseGreen)
                        Text("BPM").font(.caption.bold()).foregroundStyle(Color.pulseMuted)
                        Spacer()
                    }
                    if let remaining = monitor.calibrationRemaining { CalibrationView(remaining: remaining) }
                    Text(monitor.status).font(.body.weight(.medium)).foregroundStyle(Color.pulseMuted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .cardStyle()

                Button { monitor.isMonitoring ? monitor.stop() : monitor.start() } label: {
                    Label(monitor.isMonitoring ? "Pause measurement" : "Start measurement",
                          systemImage: monitor.isMonitoring ? "pause.fill" : "play.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(monitor.isMonitoring ? AnyButtonStyle(DangerButtonStyle()) : AnyButtonStyle(PrimaryButtonStyle()))

                Button {
                    guard let bpm = monitor.bpm else { return }
                    let reading = store.save(bpm: bpm)
                    saveMessage = "Saved \(Int(bpm.rounded())) BPM · \(reading.context)"
                } label: {
                    Label("Save measurement", systemImage: "square.and.arrow.down").frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryButtonStyle()).disabled(monitor.bpm == nil)

                Button { monitor.toggleDeveloperMode() } label: {
                    Label(monitor.developerMode ? "Hide developer signal" : "Show developer signal", systemImage: "waveform")
                }
                .font(.subheadline.bold()).foregroundStyle(Color.pulseGreen)

                if let saveMessage { Label(saveMessage, systemImage: "checkmark.circle.fill").foregroundStyle(Color.pulseGreen).font(.subheadline.bold()) }
            }
            .padding(16)
        }
        .background(Color.pulseBackground.ignoresSafeArea())
        .navigationTitle("Pulse check").navigationBarTitleDisplayMode(.inline)
        .onAppear { monitor.start() }.onDisappear { monitor.stopSession() }
    }
}

private struct HistoryView: View {
    @EnvironmentObject private var store: ReadingStore
    @State private var systolic = ""
    @State private var diastolic = ""
    @State private var symptom = ""
    @State private var severity = "Mild"
    @State private var symptomNote = ""

    private var average: Double {
        store.readings.isEmpty ? 0 : store.readings.map(\.bpm).reduce(0, +) / Double(store.readings.count)
    }
    private var domain: ClosedRange<Double> {
        let values = store.readings.map(\.bpm)
        let low = max(30, (values.min() ?? 60) - 12)
        return low...max(low + 30, min(200, (values.max() ?? 100) + 12))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Pulse and medication timeline")
                    .font(.system(size: 34, weight: .bold, design: .rounded)).foregroundStyle(Color.pulseInk)
                Text("Dose markers help show when each pulse estimate was recorded.").foregroundStyle(Color.pulseMuted)

                HStack(spacing: 12) {
                    MetricCard(value: "\(store.readings.count)", label: "Readings", icon: "heart.text.square", colour: .pulseGreen)
                    MetricCard(value: store.readings.isEmpty ? "—" : "\(Int(average.rounded()))",
                               label: "Average BPM", icon: "waveform.path.ecg", colour: .pulseRed)
                }

                if store.readings.isEmpty {
                    EmptyCard(icon: "chart.xyaxis.line", title: "No pulse history",
                              message: "Save a confirmed measurement to begin your timeline.")
                } else {
                    Chart {
                        ForEach(store.readings) { reading in
                            LineMark(x: .value("Time", reading.date), y: .value("BPM", reading.bpm))
                                .foregroundStyle(Color.pulseGreen).lineStyle(StrokeStyle(lineWidth: 3))
                            PointMark(x: .value("Time", reading.date), y: .value("BPM", reading.bpm))
                                .foregroundStyle(Color.pulseGreen).symbolSize(50)
                        }
                        ForEach(store.doses) { dose in
                            RuleMark(x: .value("Dose", dose.date))
                                .foregroundStyle(Color.pulseOrange.opacity(0.8))
                                .lineStyle(StrokeStyle(lineWidth: 2, dash: [5, 4]))
                                .annotation(position: .top, alignment: .leading) {
                                    Text("💊 \(dose.medicationName)").font(.caption2.bold()).foregroundStyle(Color.pulseInk)
                                }
                        }
                    }
                    .chartYScale(domain: domain).chartYAxisLabel("BPM")
                    .frame(height: 320).padding(14).background(Color.white, in: RoundedRectangle(cornerRadius: 22))

                    Text("Recent activity").font(.title3.bold()).foregroundStyle(Color.pulseInk)
                    ForEach(store.readings.sorted { $0.date > $1.date }) { reading in
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(reading.date, format: .dateTime.day().month(.abbreviated).hour().minute())
                                    .font(.subheadline.bold()).foregroundStyle(Color.pulseInk)
                                Text(reading.context).font(.caption).foregroundStyle(Color.pulseMuted)
                            }
                            Spacer()
                            Text("\(Int(reading.bpm.rounded())) BPM").font(.headline.monospacedDigit()).foregroundStyle(Color.pulseGreen)
                        }
                        .padding(15).background(Color.white, in: RoundedRectangle(cornerRadius: 16))
                    }
                }

                VStack(alignment: .leading, spacing: 12) {
                    Label("Add blood pressure", systemImage: "gauge.with.dots.needle.50percent")
                        .font(.title3.bold()).foregroundStyle(Color.pulseInk)
                    Text("Enter a reading from a validated cuff. PulseWindow does not estimate blood pressure from the camera.")
                        .foregroundStyle(Color.pulseMuted)
                    HStack {
                        TextField("Systolic", text: $systolic).keyboardType(.numberPad)
                            .textFieldStyle(.roundedBorder)
                        Text("/").font(.title2.bold()).foregroundStyle(Color.pulseMuted)
                        TextField("Diastolic", text: $diastolic).keyboardType(.numberPad)
                            .textFieldStyle(.roundedBorder)
                        Text("mmHg").font(.caption.bold()).foregroundStyle(Color.pulseMuted)
                    }
                    Button {
                        guard let top = Int(systolic), let bottom = Int(diastolic),
                              (50...260).contains(top), (30...160).contains(bottom) else { return }
                        store.addBloodPressure(systolic: top, diastolic: bottom)
                        systolic = ""; diastolic = ""
                    } label: { Label("Save cuff reading", systemImage: "plus.circle.fill").frame(maxWidth: .infinity) }
                        .buttonStyle(SecondaryButtonStyle())
                }
                .cardStyle()

                VStack(alignment: .leading, spacing: 12) {
                    Label("Record a symptom", systemImage: "cross.case.fill")
                        .font(.title3.bold()).foregroundStyle(Color.pulseInk)
                    TextField("Symptom (for example dizziness)", text: $symptom)
                        .textFieldStyle(.roundedBorder)
                    Picker("Severity", selection: $severity) {
                        Text("Mild").tag("Mild"); Text("Moderate").tag("Moderate"); Text("Severe").tag("Severe")
                    }.pickerStyle(.segmented)
                    TextField("Optional note", text: $symptomNote, axis: .vertical)
                        .textFieldStyle(.roundedBorder)
                    Button {
                        guard !symptom.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                        store.addSymptom(symptom, severity: severity, note: symptomNote)
                        symptom = ""; symptomNote = ""
                    } label: { Label("Save symptom", systemImage: "plus.circle.fill").frame(maxWidth: .infinity) }
                        .buttonStyle(SecondaryButtonStyle())
                }
                .cardStyle()

                if !store.bloodPressure.isEmpty || !store.symptoms.isEmpty || !store.doses.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Other recent activity").font(.title3.bold()).foregroundStyle(Color.pulseInk)
                        ForEach(store.bloodPressure.suffix(5).reversed()) { reading in
                            HistoryRow(icon: "gauge.with.dots.needle.50percent",
                                       title: "\(reading.systolic)/\(reading.diastolic) mmHg",
                                       detail: "Blood pressure · \(reading.source)", date: reading.date)
                        }
                        ForEach(store.symptoms.suffix(5).reversed()) { entry in
                            HistoryRow(icon: "cross.case.fill", title: "\(entry.symptom) · \(entry.severity)",
                                       detail: entry.note.isEmpty ? "Symptom" : entry.note, date: entry.date)
                        }
                        ForEach(store.doses.suffix(5).reversed()) { dose in
                            HistoryRow(icon: "pill.fill", title: dose.medicationName,
                                       detail: "Dose logged", date: dose.date)
                        }
                    }.cardStyle()
                }

                ShareLink(item: store.exportText, subject: Text("PulseWindow monitoring summary")) {
                    Label("Export clinician summary", systemImage: "square.and.arrow.up").frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryButtonStyle())

                Text("Review exported estimates with a qualified healthcare professional. Do not change medication based on this app alone.")
                    .font(.footnote).foregroundStyle(Color.pulseMuted)
            }
            .padding(18)
        }
        .background(Color.pulseBackground.ignoresSafeArea())
        .navigationTitle("History").navigationBarTitleDisplayMode(.inline)
    }
}

private struct HistoryRow: View {
    let icon: String
    let title: String
    let detail: String
    let date: Date

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon).foregroundStyle(Color.pulseGreen).frame(width: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.body.bold()).foregroundStyle(Color.pulseInk)
                Text(detail).font(.subheadline).foregroundStyle(Color.pulseMuted)
                Text(date, format: .dateTime.day().month(.abbreviated).hour().minute())
                    .font(.caption).foregroundStyle(Color.pulseMuted)
            }
            Spacer()
        }
        if date != Date.distantPast { Divider() }
    }
}

private struct CalibrationView: View {
    let remaining: Int
    private let totalSeconds = 15

    var body: some View {
        VStack(spacing: 9) {
            HStack { Text("Calibrating").font(.headline).foregroundStyle(Color.pulseGreen); Spacer(); Text("\(remaining) sec").font(.headline.monospacedDigit()).foregroundStyle(Color.pulseInk) }
            ProgressView(value: Double(totalSeconds - remaining) / Double(totalSeconds))
                .tint(Color.pulseGreen)
        }
        .padding(14).background(Color.pulseGreen.opacity(0.09), in: RoundedRectangle(cornerRadius: 14))
    }
}

private struct PulsingHeart: View {
    let bpm: Double?; let active: Bool
    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30)) { timeline in
            let interval = 60 / max(bpm ?? 60, 1)
            let phase = timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: interval) / interval
            Image(systemName: "heart.fill").font(.system(size: 48))
                .foregroundStyle(bpm == nil ? Color.gray.opacity(0.5) : Color.pulseRed)
                .scaleEffect(active && bpm != nil && phase < 0.18 ? 1 + 0.22 * sin(.pi * phase / 0.18) : 1)
        }.frame(width: 58, height: 58).accessibilityHidden(true)
    }
}

private struct MetricCard: View {
    let value: String; let label: String; let icon: String; let colour: Color
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: icon).foregroundStyle(colour).font(.title3)
            Text(value).font(.title.bold().monospacedDigit()).foregroundStyle(Color.pulseInk)
            Text(label).font(.caption).foregroundStyle(Color.pulseMuted)
        }.frame(maxWidth: .infinity, alignment: .leading).cardStyle()
    }
}

private struct EmptyCard: View {
    let icon: String; let title: String; let message: String
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: icon).font(.system(size: 34)).foregroundStyle(Color.pulseGreen)
            Text(title).font(.headline).foregroundStyle(Color.pulseInk)
            Text(message).multilineTextAlignment(.center).foregroundStyle(Color.pulseMuted)
        }.frame(maxWidth: .infinity).padding(.vertical, 28).cardStyle()
    }
}

private struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.headline).foregroundStyle(Color.white).padding(.horizontal, 18)
            .frame(minHeight: 56).background(Color.pulseGreen.opacity(configuration.isPressed ? 0.78 : 1), in: RoundedRectangle(cornerRadius: 15))
    }
}
private struct SecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.headline).foregroundStyle(Color.pulseGreen).padding(.horizontal, 18)
            .frame(minHeight: 56).background(Color.white, in: RoundedRectangle(cornerRadius: 15))
            .overlay(RoundedRectangle(cornerRadius: 15).stroke(Color.pulseGreen.opacity(0.25)))
    }
}
private struct CompactButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.subheadline.bold()).foregroundStyle(Color.white).padding(.horizontal, 16).frame(minHeight: 42)
            .background(Color.pulseGreen.opacity(configuration.isPressed ? 0.78 : 1), in: Capsule())
    }
}
private struct DangerButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.headline).foregroundStyle(Color.white).padding(.horizontal, 18)
            .frame(minHeight: 56).background(Color.pulseRed, in: RoundedRectangle(cornerRadius: 15))
    }
}
private struct AnyButtonStyle: ButtonStyle {
    private let body: (Configuration) -> AnyView
    init<S: ButtonStyle>(_ style: S) { body = { AnyView(style.makeBody(configuration: $0)) } }
    func makeBody(configuration: Configuration) -> some View { body(configuration) }
}

private extension View {
    func cardStyle() -> some View {
        padding(18).background(Color.white, in: RoundedRectangle(cornerRadius: 22))
            .shadow(color: Color.pulseInk.opacity(0.045), radius: 16, y: 8)
    }
}

extension Color {
    static let pulseGreen = Color(red: 0.10, green: 0.46, blue: 0.29)
    static let pulseRed = Color(red: 0.87, green: 0.23, blue: 0.23)
    static let pulseOrange = Color(red: 0.84, green: 0.45, blue: 0.12)
    static let pulseInk = Color(red: 0.06, green: 0.18, blue: 0.14)
    static let pulseMuted = Color(red: 0.28, green: 0.36, blue: 0.33)
    static let pulseSoft = Color(red: 0.92, green: 0.96, blue: 0.94)
    static let pulseBackground = Color(red: 0.95, green: 0.97, blue: 0.96)
}

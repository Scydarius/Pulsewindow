//
//  PulseWindowApp.swift
//  PulseWindow
//
//  Created by Siddhant Sharma on 9/8/2026.
//

import SwiftUI

@main
struct PulseWindowApp: App {
    @StateObject private var monitor = CameraPulseMonitor()
    @StateObject private var store = ReadingStore()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(monitor)
                .environmentObject(store)
        }
    }
}

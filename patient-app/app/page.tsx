"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";
import { jsPDF } from "jspdf";
import JSZip from "jszip";
import {
  concatArrayBuffers,
  importSigningPrivateKeyBase64,
  isValidPrivateKeyBase64,
  isValidPublicKeyBase64,
  signReportBytes,
} from "./crypto";

type Screen = "start" | "monitor" | "medications" | "history";
type Camera = { deviceId: string; label: string };
type Reading = { id: string; bpm: number; timestamp: string; context?: string };
type Medication = {
  id: string;
  name: string;
  activeIngredient?: string;
  brand?: string;
  manufacturer?: string;
  dose: string;
  prescribedDirections?: string;
  purpose?: string;
  prescriber?: string;
  startDate?: string;
  photoDataUrl?: string;
  time: string;
  checks: number;
  doseChange: boolean;
  monitoringFrequency?: string;
  formulation?: string;
  checkTiming?: string;
  checkOffsetMinutes?: number[];
  checkTimes?: string[];
};
type DoseEvent = { id: string; medicationId: string; medicationName: string; timestamp: string };
type BloodPressureReading = {
  id: string;
  systolic: number;
  diastolic: number;
  timestamp: string;
  source: "Manual entry" | "Connected device";
};
type SymptomEntry = {
  id: string;
  symptom: string;
  severity: "Mild" | "Moderate" | "Severe";
  note?: string;
  timestamp: string;
};
type PlannedEvent = {
  id: string;
  kind: "dose" | "measurement";
  date: Date;
  medication: Medication;
  label: string;
};
type MedicationPreset = {
  id: string;
  name: string;
  routineChecks: number;
  changeChecks: number;
  monitoringFrequency: string;
  formulation: string;
  schedule: string;
  routineOffsets: number[];
  changeOffsets: number[];
};
type RGB = [number, number, number];
type Sample = { time: number; rgb: RGB };
type FaceBox = { x: number; y: number; width: number; height: number };

const STORAGE_KEY = "pulse-window-readings";
const MEDICATIONS_KEY = "pulse-window-medications";
const DOSES_KEY = "pulse-window-dose-events";
const BLOOD_PRESSURE_KEY = "pulse-window-blood-pressure";
const SYMPTOMS_KEY = "pulse-window-symptoms";
const PUBLIC_KEY_STORAGE_KEY = "pulse-window-public-key";
const PRIVATE_KEY_STORAGE_KEY = "pulse-window-private-key";
const MEDICATION_PRESETS: MedicationPreset[] = [
  {
    id: "sotalol", name: "Sotalol", routineChecks: 2, changeChecks: 3,
    monitoringFrequency: "2 pulse checks each day",
    formulation: "Standard tablet (not slow release)",
    schedule: "Resting check just before a dose and about 3 hours after it. Product information reports peak levels at 2.5–4 hours.",
    routineOffsets: [-15, 180], changeOffsets: [-15, 180, 480],
  },
  {
    id: "beta-blocker", name: "Beta blocker", routineChecks: 1, changeChecks: 1,
    monitoringFrequency: "Timing must be set after the exact medicine is entered",
    formulation: "Exact drug and immediate/slow-release form required",
    schedule: "There is no safe generic after-dose time for the whole class. Extended-release metoprolol has a steadier effect across 24 hours.",
    routineOffsets: [0], changeOffsets: [0],
  },
  {
    id: "amiodarone", name: "Amiodarone", routineChecks: 1, changeChecks: 1,
    monitoringFrequency: "1 pulse check each day at the same resting time",
    formulation: "Long-acting tablet; timing is not linked to one dose",
    schedule: "Check at the same resting time each day. Loading-dose monitoring must be set by the treating clinician and may require ECG review.",
    routineOffsets: [0], changeOffsets: [0],
  },
  {
    id: "digoxin", name: "Digoxin", routineChecks: 1, changeChecks: 1,
    monitoringFrequency: "1 pulse check each day",
    formulation: "Standard tablet",
    schedule: "For a clinician-requested post-dose response check, the reference window is 2–6 hours; this template uses 4 hours.",
    routineOffsets: [240], changeOffsets: [240],
  },
  {
    id: "clonidine-ir", name: "Clonidine (immediate release)", routineChecks: 2, changeChecks: 2,
    monitoringFrequency: "2 pulse checks each day",
    formulation: "Immediate-release tablet",
    schedule: "Resting check just before the dose and about 2 hours after it; peak levels are usually reached in 1–3 hours.",
    routineOffsets: [-15, 120], changeOffsets: [-15, 120],
  },
  {
    id: "clonidine-er", name: "Clonidine (extended release)", routineChecks: 1, changeChecks: 1,
    monitoringFrequency: "1 pulse check each day at a clinician-confirmed time",
    formulation: "Extended/slow-release tablet",
    schedule: "Absorption is delayed. Do not reuse immediate-release timing; this template leaves the check at the clinician-set time.",
    routineOffsets: [0], changeOffsets: [0],
  },
  {
    id: "ivabradine", name: "Ivabradine", routineChecks: 2, changeChecks: 2,
    monitoringFrequency: "2 pulse checks each day",
    formulation: "Standard tablet taken with food",
    schedule: "Resting check just before a dose and about 2 hours after it; food delays peak concentration by about 1 hour.",
    routineOffsets: [-15, 120], changeOffsets: [-15, 120],
  },
];
const MIN_BPM = 45;
const MAX_BPM = 180;
const MIN_QUALITY = 0.30;
const MIN_REGION_QUALITY = 0.18;
const MIN_COMBINED_QUALITY = 0.22;
const INITIAL_CALIBRATION_SECONDS = 15;
const SIGNAL_WINDOW_SECONDS = 20;
const REGION_AGREEMENT_BPM = 10;

// Set VITE_DEV_MODE=true when starting the dev server to enable developer-only
// tools (e.g. simulating a BPM reading without a camera). Off by default so it
// never ships to real users.
const DEV_MODE = import.meta.env.VITE_DEV_MODE === "true";

const RECENT_READINGS_COUNT = 20;
const DOSE_RESPONSE_OFFSETS_MINUTES = [15, 30, 45, 60];
const DOSE_BASELINE_WINDOW_MINUTES = 45;
const DOSE_RESPONSE_TOLERANCE_MINUTES = 15;

// Closest reading to targetTime, within toleranceMinutes either side.
function nearestReadingWithin(
  readings: Reading[],
  targetTime: number,
  toleranceMinutes: number,
): Reading | null {
  const toleranceMs = toleranceMinutes * 60_000;
  let best: Reading | null = null;
  let bestDiff = Infinity;
  readings.forEach((reading) => {
    const diff = Math.abs(new Date(reading.timestamp).getTime() - targetTime);
    if (diff <= toleranceMs && diff < bestDiff) {
      best = reading;
      bestDiff = diff;
    }
  });
  return best;
}

// Closest reading at or before doseTime, within windowMinutes beforehand —
// used as the pre-dose baseline, so a later reading can never be mistaken
// for "before the dose".
function nearestReadingBefore(
  readings: Reading[],
  doseTime: number,
  windowMinutes: number,
): Reading | null {
  const windowMs = windowMinutes * 60_000;
  let best: Reading | null = null;
  let bestDiff = Infinity;
  readings.forEach((reading) => {
    const diff = doseTime - new Date(reading.timestamp).getTime();
    if (diff >= 0 && diff <= windowMs && diff < bestDiff) {
      best = reading;
      bestDiff = diff;
    }
  });
  return best;
}

type ExportEntry = { path: string; data: ArrayBuffer | string };

function formatDateTimeForFilename(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

function csvCell(value: string | number | undefined): string {
  const text = value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

// Writes one entry into a real directory tree via the File System Access
// API, creating any intermediate folders (e.g. "DigitalSignature/hash.txt")
// as needed.
async function writeExportEntry(root: FileSystemDirectoryHandle, entry: ExportEntry): Promise<void> {
  const segments = entry.path.split("/");
  const fileName = segments.pop()!;
  let directory = root;
  for (const segment of segments) {
    directory = await directory.getDirectoryHandle(segment, { create: true });
  }
  const fileHandle = await directory.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(entry.data);
  await writable.close();
}

function presetForMedicineName(medicineName: string) {
  const name = medicineName.toLowerCase();
  if (name.includes("sotalol")) return MEDICATION_PRESETS.find((item) => item.id === "sotalol");
  if (name.includes("amiodarone")) return MEDICATION_PRESETS.find((item) => item.id === "amiodarone");
  if (name.includes("digoxin")) return MEDICATION_PRESETS.find((item) => item.id === "digoxin");
  if (name.includes("ivabradine")) return MEDICATION_PRESETS.find((item) => item.id === "ivabradine");
  if (name.includes("clonidine")) {
    const id = name.includes("extended") || name.includes("slow") ? "clonidine-er" : "clonidine-ir";
    return MEDICATION_PRESETS.find((item) => item.id === id);
  }
  if (name.includes("beta blocker") || name.includes("beta-blocker")) {
    return MEDICATION_PRESETS.find((item) => item.id === "beta-blocker");
  }
  return undefined;
}

function upgradeMedicationPlan(medication: Medication): Medication {
  const preset = presetForMedicineName(medication.name);
  if (!preset) return medication;
  return {
    ...medication,
    monitoringFrequency: preset.monitoringFrequency,
    formulation: preset.formulation,
    checkTiming: preset.schedule,
    checkOffsetMinutes: medication.doseChange ? preset.changeOffsets : preset.routineOffsets,
  };
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function standardDeviation(values: number[]) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      values.length,
  );
}

function checkOffsets(count: number) {
  if (count >= 4) return [-60, 120, 300, 480];
  if (count === 3) return [-60, 240, 480];
  if (count === 2) return [-60, 480];
  return [0];
}

function medicationCheckOffsets(medication: Medication) {
  return medication.checkOffsetMinutes?.length
    ? medication.checkOffsetMinutes
    : checkOffsets(medication.checks);
}

function reminderTiming(offset: number) {
  if (offset === 0) return "Time for your planned resting pulse check";
  const minutes = Math.abs(offset);
  const amount = minutes % 60 === 0
    ? `${minutes / 60} hour${minutes === 60 ? "" : "s"}`
    : `${minutes} minutes`;
  return `Time for your planned pulse check ${amount} ${offset < 0 ? "before" : "after"} the dose`;
}

function reminderTimeSummary(medication: Medication) {
  if (medication.checkTimes?.length) {
    return medication.checkTimes.map((time) => {
      const [hour, minute] = time.split(":").map(Number);
      const date = new Date();
      date.setHours(hour, minute, 0, 0);
      return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }).join(", ");
  }
  return reminderTimesFor(medication.time, medicationCheckOffsets(medication));
}

function reminderTimesFor(time: string, offsets: number[]) {
  const [hour, minute] = time.split(":").map(Number);
  const doseMinutes = hour * 60 + minute;
  return offsets.map((offset) => {
    const target = (doseMinutes + offset + 1440) % 1440;
    const date = new Date();
    date.setHours(Math.floor(target / 60), target % 60, 0, 0);
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }).join(", ");
}

function upcomingPlanEvents(medications: Medication[], now: Date): PlannedEvent[] {
  const events: PlannedEvent[] = [];
  medications.forEach((medication) => {
    const [hour, minute] = medication.time.split(":").map(Number);
    for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
      const doseDate = new Date(now);
      doseDate.setDate(now.getDate() + dayOffset);
      doseDate.setHours(hour, minute, 0, 0);
      events.push({
        id: `dose-${medication.id}-${doseDate.toISOString()}`,
        kind: "dose",
        date: doseDate,
        medication,
        label: `Medication time: ${medication.name}`,
      });
      const checks = medication.checkTimes?.length
        ? medication.checkTimes.map((time, index) => {
            const [checkHour, checkMinute] = time.split(":").map(Number);
            const date = new Date(doseDate);
            date.setHours(checkHour, checkMinute, 0, 0);
            return { date, index };
          })
        : medicationCheckOffsets(medication).map((offset, index) => ({
            date: new Date(doseDate.getTime() + offset * 60_000), index,
          }));
      checks.forEach(({ date: checkDate, index }) => {
        events.push({
          id: `check-${medication.id}-${index}-${checkDate.toISOString()}`,
          kind: "measurement",
          date: checkDate,
          medication,
          label: `Pulse measurement for ${medication.name}`,
        });
      });
    }
  });
  return events
    .filter((event) => event.date.getTime() >= now.getTime() - 15 * 60_000)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

function relativePlanTime(date: Date, now: Date) {
  const minutes = Math.round((date.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0 && minutes >= -15) return "Due now";
  if (minutes < 60) return `In ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `In ${hours} hour${hours === 1 ? "" : "s"}`;
  return date.toLocaleDateString([], { weekday: "long" });
}

function interpolateSamples(samples: Sample[], fps = 30) {
  const start = samples[0].time;
  const end = samples.at(-1)!.time;
  const count = Math.floor((end - start) * fps);
  const output: [number, number, number][] = [];
  let source = 0;

  for (let index = 0; index < count; index += 1) {
    const time = start + index / fps;
    while (source + 1 < samples.length && samples[source + 1].time < time) {
      source += 1;
    }
    if (source + 1 >= samples.length) break;
    const a = samples[source];
    const b = samples[source + 1];
    const fraction = (time - a.time) / Math.max(b.time - a.time, 1e-6);
    output.push([
      a.rgb[0] + (b.rgb[0] - a.rgb[0]) * fraction,
      a.rgb[1] + (b.rgb[1] - a.rgb[1]) * fraction,
      a.rgb[2] + (b.rgb[2] - a.rgb[2]) * fraction,
    ]);
  }
  return output;
}

function combineRegionSamples(regionSamples: Sample[][]) {
  const count = Math.min(...regionSamples.map((samples) => samples.length));
  if (!Number.isFinite(count) || count === 0) return [];
  const starts = regionSamples.map((samples) => samples.length - count);
  return Array.from({ length: count }, (_, index) => {
    const samples = regionSamples.map((region, regionIndex) => region[starts[regionIndex] + index]);
    return {
      time: samples[0].time,
      rgb: [0, 1, 2].map((channel) =>
        median(samples.map((sample) => sample.rgb[channel]))
      ) as RGB,
    };
  });
}

function estimateBPM(samples: Sample[]) {
  if (
    samples.length < 200 ||
    samples.at(-1)!.time - samples[0].time < INITIAL_CALIBRATION_SECONDS - 0.5
  ) {
    return null;
  }

  const fps = 30;
  const colours = interpolateSamples(samples, fps);
  const windowSize = Math.round(1.6 * fps);
  if (colours.length <= windowSize) return null;

  const pulse = new Array(colours.length).fill(0);
  const weights = new Array(colours.length).fill(0);

  for (let start = 0; start <= colours.length - windowSize; start += 1) {
    const segment = colours.slice(start, start + windowSize);
    const means = [0, 1, 2].map(
      (channel) =>
        segment.reduce((sum, colour) => sum + colour[channel], 0) / windowSize,
    );
    const x: number[] = [];
    const y: number[] = [];
    segment.forEach((colour) => {
      const red = colour[0] / means[0] - 1;
      const green = colour[1] / means[1] - 1;
      const blue = colour[2] / means[2] - 1;
      x.push(green - blue);
      y.push(green + blue - 2 * red);
    });
    const alpha = standardDeviation(x) / Math.max(standardDeviation(y), 1e-10);
    const projected = x.map((value, index) => value + alpha * y[index]);
    const mean = projected.reduce((sum, value) => sum + value, 0) / windowSize;
    projected.forEach((value, offset) => {
      pulse[start + offset] += value - mean;
      weights[start + offset] += 1;
    });
  }

  pulse.forEach((_, index) => {
    if (weights[index] > 0) pulse[index] /= weights[index];
  });
  const pulseMean = pulse.reduce((sum, value) => sum + value, 0) / pulse.length;
  pulse.forEach((_, index) => (pulse[index] -= pulseMean));

  const powers: { bpm: number; power: number; real: number; imaginary: number }[] = [];
  for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += 0.5) {
    const frequency = bpm / 60;
    let real = 0;
    let imaginary = 0;
    pulse.forEach((value, index) => {
      const angle = (2 * Math.PI * frequency * index) / fps;
      const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / Math.max(1, pulse.length - 1));
      real += value * hann * Math.cos(angle);
      imaginary -= value * hann * Math.sin(angle);
    });
    powers.push({ bpm, power: real ** 2 + imaginary ** 2, real, imaginary });
  }

  let peak = powers.reduce((best, item) => (item.power > best.power ? item : best));
  if (peak.bpm >= 90) {
    const half = powers.reduce((best, item) =>
      Math.abs(item.bpm - peak.bpm / 2) < Math.abs(best.bpm - peak.bpm / 2) ? item : best
    );
    if (half.power >= peak.power * 0.65) peak = half;
  }
  const total = powers.reduce((sum, item) => sum + item.power, 0);
  const local = powers
    .filter((item) => Math.abs(item.bpm - peak.bpm) <= 9)
    .reduce((sum, item) => sum + item.power, 0);
  const angularFrequency = (2 * Math.PI * (peak.bpm / 60)) / fps;
  const phase = Math.atan2(-peak.imaginary, peak.real);
  const lastIndex = pulse.length - 1;
  const completedCycles = Math.floor((angularFrequency * lastIndex + phase) / (2 * Math.PI));
  const lastPeakIndex = (completedCycles * 2 * Math.PI - phase) / angularFrequency;
  const beatAge = Math.max(0, (lastIndex - lastPeakIndex) / fps);
  return { bpm: peak.bpm, quality: total > 0 ? local / total : 0, beatAge };
}

type PulseEstimate = NonNullable<ReturnType<typeof estimateBPM>>;

function agreeAcrossRegions(estimates: PulseEstimate[]) {
  const pairs: [PulseEstimate, PulseEstimate][] = [];
  for (let first = 0; first < estimates.length; first += 1) {
    for (let second = first + 1; second < estimates.length; second += 1) {
      const a = estimates[first];
      const b = estimates[second];
      if (Math.abs(a.bpm - b.bpm) <= REGION_AGREEMENT_BPM) pairs.push([a, b]);
    }
  }

  let pair = pairs.sort(
    (a, b) => b[0].quality + b[1].quality - (a[0].quality + a[1].quality),
  )[0];

  if (!pair) {
    const harmonicPairs: [PulseEstimate, PulseEstimate][] = [];
    for (let first = 0; first < estimates.length; first += 1) {
      for (let second = first + 1; second < estimates.length; second += 1) {
        const lower = estimates[first].bpm <= estimates[second].bpm
          ? estimates[first]
          : estimates[second];
        const higher = lower === estimates[first] ? estimates[second] : estimates[first];
        if (
          higher.bpm >= 90 &&
          Math.abs(higher.bpm / 2 - lower.bpm) <= REGION_AGREEMENT_BPM
        ) {
          harmonicPairs.push([
            lower,
            { ...higher, bpm: higher.bpm / 2, quality: higher.quality * 0.85 },
          ]);
        }
      }
    }
    pair = harmonicPairs.sort(
      (a, b) => b[0].quality + b[1].quality - (a[0].quality + a[1].quality),
    )[0];
  }

  if (!pair) return null;
  const weights = pair.map((estimate) => estimate.quality ** 2);
  const weightTotal = weights[0] + weights[1];
  const strongest = pair[0].quality >= pair[1].quality ? pair[0] : pair[1];
  return {
    bpm: (pair[0].bpm * weights[0] + pair[1].bpm * weights[1]) / weightTotal,
    quality: (pair[0].quality + pair[1].quality) / 2,
    beatAge: strongest.beatAge,
  };
}

function faceRegions(face: FaceBox) {
  return [
    [face.x + face.width * 0.25, face.y + face.height * 0.10, face.width * 0.50, face.height * 0.18],
    [face.x + face.width * 0.12, face.y + face.height * 0.48, face.width * 0.25, face.height * 0.18],
    [face.x + face.width * 0.63, face.y + face.height * 0.48, face.width * 0.25, face.height * 0.18],
  ];
}

function sampleRegions(context: CanvasRenderingContext2D, face: FaceBox) {
  const width = context.canvas.width;
  const height = context.canvas.height;
  const regions = faceRegions(face);
  return regions.map(([rx, ry, rw, rh]) => {
    let red = 0;
    let green = 0;
    let blue = 0;
    let pixels = 0;
    const x = Math.max(0, Math.floor(rx));
    const y = Math.max(0, Math.floor(ry));
    const regionWidth = Math.max(1, Math.min(width - x, Math.floor(rw)));
    const regionHeight = Math.max(1, Math.min(height - y, Math.floor(rh)));
    const image = context.getImageData(
      x,
      y,
      regionWidth,
      regionHeight,
    ).data;
    for (let index = 0; index < image.length; index += 16) {
      red += image[index];
      green += image[index + 1];
      blue += image[index + 2];
      pixels += 1;
    }
    return [red / pixels, green / pixels, blue / pixels] as RGB;
  });
}

function drawGreenDiagnostic(
  source: HTMLCanvasElement,
  target: HTMLCanvasElement,
  face: FaceBox | null,
  previousBaseline: Float32Array | null,
) {
  const context = target.getContext("2d", { willReadFrequently: true })!;
  const sourceContext = source.getContext("2d", { willReadFrequently: true })!;
  const sourceImage = sourceContext.getImageData(0, 0, source.width, source.height);
  const output = context.createImageData(target.width, target.height);
  const baseline =
    previousBaseline?.length === source.width * source.height
      ? previousBaseline
      : new Float32Array(source.width * source.height);

  for (let pixel = 0, index = 0; index < sourceImage.data.length; pixel += 1, index += 4) {
    const green = sourceImage.data[index + 1];
    if (!previousBaseline) baseline[pixel] = green;
    else baseline[pixel] = baseline[pixel] * 0.96 + green * 0.04;
    const change = Math.max(-80, Math.min(80, (green - baseline[pixel]) * 24));

    if (change >= 0) {
      output.data[index] = 8;
      output.data[index + 1] = Math.min(255, 36 + change * 2.7);
      output.data[index + 2] = 18;
    } else {
      const decrease = -change;
      output.data[index] = Math.min(255, 26 + decrease * 2.1);
      output.data[index + 1] = 12;
      output.data[index + 2] = Math.min(255, 42 + decrease * 2.2);
    }
    output.data[index + 3] = 255;
  }
  context.putImageData(output, 0, 0);

  if (!face) return baseline;
  const scaleX = target.width / source.width;
  const scaleY = target.height / source.height;
  const regions = faceRegions(face);
  context.strokeStyle = "#f7ff78";
  context.lineWidth = 2;
  regions.forEach(([x, y, width, height]) => {
    context.strokeRect(
      x * scaleX,
      y * scaleY,
      width * scaleX,
      height * scaleY,
    );
  });
  return baseline;
}

function drawPulseGraph(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  readings: Reading[],
  doses: DoseEvent[],
) {
  context.clearRect(0, 0, width, height);
  if (!readings.length) return;
  const ordered = [...readings].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  const values = ordered.map((reading) => reading.bpm);
  const times = ordered.map((reading) => new Date(reading.timestamp).getTime());
  const timeStart = Math.min(...times);
  const timeEnd = Math.max(...times);
  const timeSpan = Math.max(1, timeEnd - timeStart);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const valueSpan = Math.max(30, high - low + 20);
  const middle = (low + high) / 2;
  const yMin = Math.max(30, middle - valueSpan / 2);
  const yMax = Math.min(200, middle + valueSpan / 2);
  const margin = { left: 48, right: 20, top: 22, bottom: 50 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const x = (index: number) =>
    ordered.length === 1
      ? margin.left + plotWidth / 2
      : margin.left + ((times[index] - timeStart) / timeSpan) * plotWidth;
  const y = (value: number) =>
    margin.top + ((yMax - value) * plotHeight) / (yMax - yMin);

  doses.forEach((dose) => {
    const doseTime = new Date(dose.timestamp).getTime();
    if (doseTime < timeStart || doseTime > timeEnd) return;
    const doseX = margin.left + ((doseTime - timeStart) / timeSpan) * plotWidth;
    context.save();
    context.setLineDash([5, 4]);
    context.strokeStyle = "#d77a21";
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(doseX, margin.top);
    context.lineTo(doseX, margin.top + plotHeight);
    context.stroke();
    context.restore();
    context.fillStyle = "#75400d";
    context.font = "bold 11px system-ui";
    context.textAlign = "left";
    context.fillText(`💊 ${dose.medicationName}`, Math.min(doseX + 4, width - 100), margin.top + 4);
  });

  context.font = "12px system-ui";
  context.textAlign = "right";
  context.textBaseline = "middle";
  for (let index = 0; index < 5; index += 1) {
    const value = yMin + (index * (yMax - yMin)) / 4;
    const rowY = y(value);
    context.strokeStyle = "#dce7e2";
    context.beginPath();
    context.moveTo(margin.left, rowY);
    context.lineTo(width - margin.right, rowY);
    context.stroke();
    context.fillStyle = "#607069";
    context.fillText(value.toFixed(0), margin.left - 9, rowY);
  }

  const axisFormatter = new Intl.DateTimeFormat(undefined, timeSpan < 86_400_000
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric" });
  context.textBaseline = "top";
  for (let tick = 0; tick < 3; tick += 1) {
    const fraction = tick / 2;
    const tickX = margin.left + fraction * plotWidth;
    const tickTime = ordered.length === 1 ? times[0] : timeStart + fraction * timeSpan;
    context.strokeStyle = "#edf2ef";
    context.beginPath();
    context.moveTo(tickX, margin.top);
    context.lineTo(tickX, margin.top + plotHeight);
    context.stroke();
    context.fillStyle = "#607069";
    context.textAlign = tick === 0 ? "left" : tick === 2 ? "right" : "center";
    context.fillText(axisFormatter.format(new Date(tickTime)), tickX, height - 28);
  }

  if (ordered.length > 1) {
    const gradient = context.createLinearGradient(0, margin.top, 0, margin.top + plotHeight);
    gradient.addColorStop(0, "rgba(25, 118, 74, .20)");
    gradient.addColorStop(1, "rgba(25, 118, 74, 0)");
    context.beginPath();
    values.forEach((value, index) => {
      if (index === 0) context.moveTo(x(index), y(value));
      else context.lineTo(x(index), y(value));
    });
    context.lineTo(x(values.length - 1), margin.top + plotHeight);
    context.lineTo(x(0), margin.top + plotHeight);
    context.closePath();
    context.fillStyle = gradient;
    context.fill();

    context.strokeStyle = "#19764a";
    context.lineWidth = 3;
    context.lineJoin = "round";
    context.beginPath();
    values.forEach((value, index) => {
      if (index === 0) context.moveTo(x(index), y(value));
      else context.lineTo(x(index), y(value));
    });
    context.stroke();
  }
  values.forEach((value, index) => {
    context.fillStyle = index === values.length - 1 ? "#df3b3b" : "#19764a";
    context.beginPath();
    context.arc(x(index), y(value), 5, 0, 2 * Math.PI);
    context.fill();
  });
}

function HistoryGraph({ readings, doses }: { readings: Reading[]; doses: DoseEvent[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !readings.length) return;

    const draw = () => {
      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      const context = canvas.getContext("2d")!;
      context.scale(ratio, ratio);
      drawPulseGraph(context, width, height, readings, doses);
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [readings, doses]);

  if (!readings.length) return <div className="empty-history">No saved measurements yet</div>;
  return <canvas className="history-graph" ref={canvasRef} role="img" aria-label="Saved pulse measurements plotted over time" />;
}

export default function Home() {
  const [screen, setScreen] = useState<Screen>("start");
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [selectedCamera, setSelectedCamera] = useState("");
  const [monitoring, setMonitoring] = useState(false);
  const [bpm, setBpm] = useState<number | null>(null);
  const [status, setStatus] = useState("Ready to measure");
  const [calibrationSeconds, setCalibrationSeconds] = useState<number | null>(null);
  const [beatSync, setBeatSync] = useState({ age: 0, revision: 0 });
  const [developerMode, setDeveloperMode] = useState(false);
  const [simulatedBpmInput, setSimulatedBpmInput] = useState("");
  const [devTimeOffsetInput, setDevTimeOffsetInput] = useState("0");
  const [faceBox, setFaceBox] = useState<FaceBox | null>(null);
  const [readings, setReadings] = useState<Reading[]>([]);
  const [medications, setMedications] = useState<Medication[]>([]);
  const [doses, setDoses] = useState<DoseEvent[]>([]);
  const [bloodPressure, setBloodPressure] = useState<BloodPressureReading[]>([]);
  const [symptoms, setSymptoms] = useState<SymptomEntry[]>([]);
  const [medicineName, setMedicineName] = useState("");
  const [medicineActiveIngredient, setMedicineActiveIngredient] = useState("");
  const [medicineBrand, setMedicineBrand] = useState("");
  const [medicineManufacturer, setMedicineManufacturer] = useState("");
  const [medicineDose, setMedicineDose] = useState("");
  const [medicineDirections, setMedicineDirections] = useState("");
  const [medicinePurpose, setMedicinePurpose] = useState("");
  const [medicinePrescriber, setMedicinePrescriber] = useState("");
  const [medicineStartDate, setMedicineStartDate] = useState("");
  const [medicinePhoto, setMedicinePhoto] = useState("");
  const [medicineTime, setMedicineTime] = useState("09:00");
  const [medicineChecks, setMedicineChecks] = useState(1);
  const [medicineCheckTime, setMedicineCheckTime] = useState("09:00");
  const [doseChange, setDoseChange] = useState(false);
  const [selectedPresetId, setSelectedPresetId] = useState("custom");
  const [patientNotice, setPatientNotice] = useState("");
  const [bpSystolic, setBpSystolic] = useState("");
  const [bpDiastolic, setBpDiastolic] = useState("");
  const [symptomName, setSymptomName] = useState("");
  const [symptomSeverity, setSymptomSeverity] = useState<SymptomEntry["severity"]>("Mild");
  const [symptomNote, setSymptomNote] = useState("");
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [privateKey, setPrivateKey] = useState<string | null>(null);
  const [keysLoaded, setKeysLoaded] = useState(false);
  const [keySetupPublicInput, setKeySetupPublicInput] = useState("");
  const [keySetupPrivateInput, setKeySetupPrivateInput] = useState("");
  const [keySetupError, setKeySetupError] = useState("");
  const [keySetupSaving, setKeySetupSaving] = useState(false);
  const [showKeySetup, setShowKeySetup] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | "unsupported">("unsupported");
  const [clock, setClock] = useState(() => new Date());
  const videoRef = useRef<HTMLVideoElement>(null);
  const workCanvasRef = useRef<HTMLCanvasElement>(null);
  const diagnosticCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationRef = useRef<number | null>(null);
  const regionSamplesRef = useRef<Sample[][]>([[], [], []]);
  const candidatesRef = useRef<number[]>([]);
  const pendingJumpRef = useRef<number[]>([]);
  const lastEstimateRef = useRef(0);
  const bpmRef = useRef<number | null>(null);
  const developerModeRef = useRef(false);
  const greenBaselineRef = useRef<Float32Array | null>(null);
  const faceDetectorRef = useRef<FaceDetector | null>(null);
  const faceBoxRef = useRef<FaceBox | null>(null);
  const lastFaceDetectionRef = useRef(0);
  const faceLastSeenRef = useRef(0);
  const unstableUntilRef = useRef(0);
  const lastBrightnessRef = useRef<number | null>(null);
  const pauseStartedRef = useRef<number | null>(null);
  const sampleOffsetsRef = useRef<RGB[]>([[0, 0, 0], [0, 0, 0], [0, 0, 0]]);

  const loadFaceDetector = useCallback(async () => {
    if (faceDetectorRef.current) return faceDetectorRef.current;
    const vision = await FilesetResolver.forVisionTasks("/mediapipe");
    const detector = await FaceDetector.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite",
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      minDetectionConfidence: 0.45,
    });
    faceDetectorRef.current = detector;
    return detector;
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) setReadings(JSON.parse(stored));
      const storedMedications = localStorage.getItem(MEDICATIONS_KEY);
      if (storedMedications) {
        const upgraded = (JSON.parse(storedMedications) as Medication[]).map(upgradeMedicationPlan);
        setMedications(upgraded);
        localStorage.setItem(MEDICATIONS_KEY, JSON.stringify(upgraded));
      }
      const storedDoses = localStorage.getItem(DOSES_KEY);
      if (storedDoses) setDoses(JSON.parse(storedDoses));
      const storedBloodPressure = localStorage.getItem(BLOOD_PRESSURE_KEY);
      if (storedBloodPressure) setBloodPressure(JSON.parse(storedBloodPressure));
      const storedSymptoms = localStorage.getItem(SYMPTOMS_KEY);
      if (storedSymptoms) setSymptoms(JSON.parse(storedSymptoms));

      setPublicKey(localStorage.getItem(PUBLIC_KEY_STORAGE_KEY));
      setPrivateKey(localStorage.getItem(PRIVATE_KEY_STORAGE_KEY));
      setKeysLoaded(true);
      setNotificationPermission("Notification" in window ? Notification.permission : "unsupported");
    }, 0);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const enableNotifications = async () => {
    if (!("Notification" in window)) {
      setNotificationPermission("unsupported");
      setPatientNotice("This browser does not support reminders. Use the iPhone app for notifications that work while closed.");
      return;
    }
    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
    setPatientNotice(permission === "granted"
      ? "Reminders are enabled while this web app is open. The iPhone app can remind you even when it is closed."
      : "Notifications are off. You can enable them later in your browser or iPhone settings.");
  };

  const saveKeys = async () => {
    const nextPublicKey = keySetupPublicInput.trim();
    const nextPrivateKey = keySetupPrivateInput.trim();
    if (!nextPublicKey || !nextPrivateKey) {
      setKeySetupError("Enter both the public key and the private key.");
      return;
    }
    setKeySetupSaving(true);
    setKeySetupError("");
    try {
      const [validPublic, validPrivate] = await Promise.all([
        isValidPublicKeyBase64(nextPublicKey),
        isValidPrivateKeyBase64(nextPrivateKey),
      ]);
      if (!validPublic || !validPrivate) {
        setKeySetupError("One or both keys don't look right. Check them against what your clinic gave you.");
        return;
      }
      localStorage.setItem(PUBLIC_KEY_STORAGE_KEY, nextPublicKey);
      localStorage.setItem(PRIVATE_KEY_STORAGE_KEY, nextPrivateKey);
      setPublicKey(nextPublicKey);
      setPrivateKey(nextPrivateKey);
      setKeySetupPublicInput("");
      setKeySetupPrivateInput("");
      setShowKeySetup(false);
      setPatientNotice("Clinician-report verification is ready on this device.");
    } finally {
      setKeySetupSaving(false);
    }
  };

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (Notification.permission !== "granted") return;
      const now = new Date();
      const currentMinutes = now.getHours() * 60 + now.getMinutes();
      medications.forEach((medication) => {
        const [hour, minute] = medication.time.split(":").map(Number);
        const doseMinutes = hour * 60 + minute;
        const measurementReminders = medication.checkTimes?.length
          ? medication.checkTimes.map((time) => {
              const [checkHour, checkMinute] = time.split(":").map(Number);
              return {
                target: checkHour * 60 + checkMinute,
                title: "Pulse check",
                body: `Time for the planned resting pulse check for ${medication.name}. Use the plan confirmed by your clinician.`,
              };
            })
          : medicationCheckOffsets(medication).map((offset) => ({
              target: (doseMinutes + offset + 1440) % 1440,
              title: "Pulse check",
              body: `${reminderTiming(offset)} for ${medication.name}. Use the plan confirmed by your clinician.`,
            }));
        const reminders = [
          { target: doseMinutes, title: "Medication check-in", body: `If you took ${medication.name}, log the dose in PulseWindow.` },
          ...measurementReminders,
        ];
        reminders.forEach((reminder, index) => {
          if (reminder.target !== currentMinutes) return;
          const key = `pulse-window-notified-${medication.id}-${index}-${now.toDateString()}`;
          if (sessionStorage.getItem(key)) return;
          navigator.serviceWorker?.ready
            .then((registration) => registration.showNotification(reminder.title, {
              body: reminder.body,
              icon: "/icon-192.png",
              tag: key,
            }))
            .catch(() => new Notification(reminder.title, { body: reminder.body }));
          sessionStorage.setItem(key, "1");
        });
      });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [medications]);

  const enumerateCameras = useCallback(async (requestPermission = false) => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setStatus("This browser does not support camera access");
      return [];
    }

    if (requestPermission) {
      const permissionStream = await navigator.mediaDevices.getUserMedia({ video: true });
      permissionStream.getTracks().forEach((track) => track.stop());
    }

    const devices = (await navigator.mediaDevices.enumerateDevices())
      .filter((device) => device.kind === "videoinput")
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `Camera ${index + 1}`,
      }));
    setCameras(devices);
    setSelectedCamera((current) => {
      if (devices.some((camera) => camera.deviceId === current)) return current;
      const frontCamera = devices.find((camera) => /front|facetime|user/i.test(camera.label));
      return frontCamera?.deviceId || devices[0]?.deviceId || "";
    });
    return devices;
  }, []);

  const findCameras = useCallback(async () => {
    try {
      return await enumerateCameras(true);
    } catch (error) {
      console.error("Camera permission request failed", error);
      const name = error instanceof DOMException ? error.name : "UnknownError";
      const reason =
        name === "NotAllowedError"
          ? "Camera access is blocked for this site. Check your browser's site settings."
          : name === "NotFoundError"
            ? "No camera was found on this device."
            : name === "NotReadableError"
              ? "The camera is already in use by another app."
              : `Could not access the camera (${name}).`;
      setStatus(reason);
      return [];
    }
  }, [enumerateCameras]);

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.enumerateDevices) return;

    const refreshCameras = () => void enumerateCameras(false);
    refreshCameras();
    mediaDevices.addEventListener?.("devicechange", refreshCameras);
    return () => mediaDevices.removeEventListener?.("devicechange", refreshCameras);
  }, [enumerateCameras]);

  const stopCamera = useCallback(() => {
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    faceBoxRef.current = null;
    greenBaselineRef.current = null;
    regionSamplesRef.current = [[], [], []];
    candidatesRef.current = [];
    pendingJumpRef.current = [];
    unstableUntilRef.current = 0;
    lastBrightnessRef.current = null;
    pauseStartedRef.current = null;
    sampleOffsetsRef.current = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    setFaceBox(null);
    setCalibrationSeconds(null);
    setMonitoring(false);
    setStatus("Monitoring stopped");
  }, []);

  const toggleDeveloperMode = () => {
    const next = !developerModeRef.current;
    developerModeRef.current = next;
    greenBaselineRef.current = null;
    setDeveloperMode(next);
  };

  const applySimulatedBpm = () => {
    const value = Number(simulatedBpmInput);
    if (!Number.isFinite(value) || value < MIN_BPM || value > MAX_BPM) {
      setStatus(`Enter a BPM between ${MIN_BPM} and ${MAX_BPM}`);
      return;
    }
    stopCamera();
    bpmRef.current = value;
    setBpm(value);
    setMonitoring(true);
    setCalibrationSeconds(null);
    setBeatSync((current) => ({ age: 0, revision: current.revision + 1 }));
    setStatus("Simulated reading — not from camera");
  };

  const analyseFrame = useCallback(function frameAnalysis() {
    const video = videoRef.current;
    const canvas = workCanvasRef.current;
    if (!video || !canvas || video.readyState < 2 || !streamRef.current) {
      animationRef.current = requestAnimationFrame(frameAnalysis);
      return;
    }
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const nowMs = performance.now();
    if (faceDetectorRef.current && nowMs - lastFaceDetectionRef.current >= 150) {
      lastFaceDetectionRef.current = nowMs;
      const result = faceDetectorRef.current.detectForVideo(video, nowMs);
      const box = result.detections[0]?.boundingBox;
      const sourceWidth = video.videoWidth || canvas.width;
      const sourceHeight = video.videoHeight || canvas.height;
      const scaleX = canvas.width / sourceWidth;
      const scaleY = canvas.height / sourceHeight;
      if (box && box.width * scaleX >= 40 && box.height * scaleY >= 40) {
        const detected = {
          x: box.originX * scaleX,
          y: box.originY * scaleY,
          width: box.width * scaleX,
          height: box.height * scaleY,
        };
        const previous = faceBoxRef.current;
        if (previous) {
          const centreMovement = Math.hypot(
            detected.x + detected.width / 2 - (previous.x + previous.width / 2),
            detected.y + detected.height / 2 - (previous.y + previous.height / 2),
          ) / Math.max(previous.width, 1);
          const sizeMovement = Math.abs(detected.width - previous.width) / Math.max(previous.width, 1);
          if (centreMovement + sizeMovement > 0.12) {
            if (pauseStartedRef.current === null) pauseStartedRef.current = nowMs;
            unstableUntilRef.current = nowMs + 1200;
          }
        }
        const smoothing = previous ? 0.18 : 1;
        const next = previous ? {
          x: previous.x + (detected.x - previous.x) * smoothing,
          y: previous.y + (detected.y - previous.y) * smoothing,
          width: previous.width + (detected.width - previous.width) * smoothing,
          height: previous.height + (detected.height - previous.height) * smoothing,
        } : detected;
        faceBoxRef.current = next;
        faceLastSeenRef.current = nowMs;
        setFaceBox(next);
      } else if (nowMs - faceLastSeenRef.current > 700) {
        faceBoxRef.current = null;
        setFaceBox(null);
        if (pauseStartedRef.current === null) pauseStartedRef.current = nowMs;
        if (nowMs - faceLastSeenRef.current > 5000) {
          regionSamplesRef.current = [[], [], []];
          candidatesRef.current = [];
          pendingJumpRef.current = [];
          sampleOffsetsRef.current = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
          setCalibrationSeconds(null);
        }
      }
    }
    if (developerModeRef.current && diagnosticCanvasRef.current) {
      greenBaselineRef.current = drawGreenDiagnostic(
        canvas,
        diagnosticCanvasRef.current,
        faceBoxRef.current,
        greenBaselineRef.current,
      );
    }
    const now = performance.now() / 1000;
    const trackedFace = faceBoxRef.current;
    if (!trackedFace) {
      if (pauseStartedRef.current === null) pauseStartedRef.current = nowMs;
      setStatus("Paused — face not found; progress is saved");
      animationRef.current = requestAnimationFrame(frameAnalysis);
      return;
    }
    const regionColours = sampleRegions(context, trackedFace);
    const brightness = regionColours.reduce(
      (sum, rgb) => sum + (rgb[0] + rgb[1] + rgb[2]) / 3,
      0,
    ) / regionColours.length;

    if (brightness < 40) {
      if (pauseStartedRef.current === null) pauseStartedRef.current = nowMs;
      setStatus("Paused — more light needed; progress is saved");
    }
    else if (brightness > 235) {
      if (pauseStartedRef.current === null) pauseStartedRef.current = nowMs;
      setStatus("Paused — too much light; progress is saved");
    }
    else if (
      lastBrightnessRef.current !== null &&
      Math.abs(brightness - lastBrightnessRef.current) > 7
    ) {
      lastBrightnessRef.current = brightness;
      if (pauseStartedRef.current === null) pauseStartedRef.current = nowMs;
      unstableUntilRef.current = nowMs + 1200;
      setStatus("Paused — lighting changed; progress is saved");
    }
    else if (nowMs < unstableUntilRef.current) {
      lastBrightnessRef.current = brightness;
      if (pauseStartedRef.current === null) pauseStartedRef.current = nowMs;
      setStatus("Paused — movement detected; progress is saved");
    }
    else {
      lastBrightnessRef.current = brightness;
      if (pauseStartedRef.current !== null) {
        const pauseSeconds = (nowMs - pauseStartedRef.current) / 1000;
        regionSamplesRef.current = regionSamplesRef.current.map((samples) =>
          samples.map((sample) => ({ ...sample, time: sample.time + pauseSeconds }))
        );
        sampleOffsetsRef.current = regionColours.map((rgb, index) => {
          const previous = regionSamplesRef.current[index].at(-1)?.rgb;
          return previous
            ? [previous[0] - rgb[0], previous[1] - rgb[1], previous[2] - rgb[2]]
            : [0, 0, 0];
        });
        pauseStartedRef.current = null;
      }
      const correctedColours = regionColours.map((rgb, index) => [
        rgb[0] + sampleOffsetsRef.current[index][0],
        rgb[1] + sampleOffsetsRef.current[index][1],
        rgb[2] + sampleOffsetsRef.current[index][2],
      ] as RGB);
      regionSamplesRef.current = regionSamplesRef.current.map((samples, index) => [
        ...samples,
        { time: now, rgb: correctedColours[index] },
      ].filter((sample) => now - sample.time <= SIGNAL_WINDOW_SECONDS + 0.5));
      const duration = now - regionSamplesRef.current[0][0].time;
      if (duration < INITIAL_CALIBRATION_SECONDS - 0.5) {
        const remaining = Math.max(1, Math.ceil(INITIAL_CALIBRATION_SECONDS - duration));
        setCalibrationSeconds(remaining);
        setStatus("Keep still while the signal builds");
      }
      else if (now - lastEstimateRef.current >= 1) {
        setCalibrationSeconds(null);
        lastEstimateRef.current = now;
        const regionEstimates = regionSamplesRef.current
          .map(estimateBPM)
          .filter((estimate): estimate is PulseEstimate =>
            estimate !== null && estimate.quality >= MIN_REGION_QUALITY
          );
        let estimate = agreeAcrossRegions(regionEstimates);
        if (estimate && estimate.quality < MIN_QUALITY) estimate = null;
        let estimateSource: "regions" | "combined" | "single" = "regions";
        if (!estimate) {
          const combined = estimateBPM(combineRegionSamples(regionSamplesRef.current));
          if (combined && combined.quality >= MIN_COMBINED_QUALITY) {
            estimate = combined;
            estimateSource = "combined";
          }
        }
        if (!estimate) {
          const strongest = [...regionEstimates].sort((a, b) => b.quality - a.quality)[0];
          if (strongest?.quality >= 0.34) {
            estimate = strongest;
            estimateSource = "single";
          }
        }
        if (!estimate) {
          setStatus("Signal weak — face steady front lighting");
        }
        else {
          candidatesRef.current.push(estimate.bpm);
          candidatesRef.current = candidatesRef.current.slice(-7);
          const recent = candidatesRef.current.slice(-5);
          if (recent.length < 5 || Math.max(...recent) - Math.min(...recent) > 6) {
            setStatus(
              estimateSource === "single"
                ? "Confirming the clearest skin region…"
                : estimateSource === "combined"
                  ? "Confirming combined face signal…"
                  : "Confirming pulse… keep still",
            );
          } else {
            let stable = median(recent);
            const current = bpmRef.current;
            if (current !== null && Math.abs(stable - current) > 10) {
              pendingJumpRef.current.push(stable);
              pendingJumpRef.current = pendingJumpRef.current.slice(-6);
              const pending = pendingJumpRef.current;
              if (pending.length < 6 || Math.max(...pending) - Math.min(...pending) > 6) {
                setStatus("Checking a possible change…");
              } else stable = median(pending);
            } else pendingJumpRef.current = [];

            if (
              current === null ||
              Math.abs(stable - current) <= 10 ||
              pendingJumpRef.current.length === 6
            ) {
              const displayed = current === null ? stable : 0.85 * current + 0.15 * stable;
              bpmRef.current = displayed;
              setBpm(displayed);
              setBeatSync((currentSync) => ({
                age: estimate.beatAge,
                revision: currentSync.revision + 1,
              }));
              setStatus(
                estimateSource === "single"
                  ? "Live reading · clearest region"
                  : estimateSource === "combined"
                    ? "Live reading · combined face signal"
                    : "Live reading",
              );
            }
          }
        }
      }
    }
    animationRef.current = requestAnimationFrame(frameAnalysis);
  }, []);

  const startCamera = useCallback(async () => {
    try {
      stopCamera();
      regionSamplesRef.current = [[], [], []];
      candidatesRef.current = [];
      pendingJumpRef.current = [];
      bpmRef.current = null;
      setBpm(null);
      const available = cameras.length ? cameras : await findCameras();
      const deviceId = selectedCamera || available[0]?.deviceId;
      const stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId
          ? { deviceId: { exact: deviceId }, width: { ideal: 640 }, height: { ideal: 480 } }
          : { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setMonitoring(true);
      setStatus("Loading face tracker…");
      await loadFaceDetector();
      setStatus("Finding your face…");
      animationRef.current = requestAnimationFrame(analyseFrame);
    } catch (error) {
      console.error("Camera could not start", error);
      stopCamera();
      const name = error instanceof DOMException ? error.name : "UnknownError";
      const reason =
        name === "NotAllowedError"
          ? "Camera access is blocked for this site. Check your browser's site settings."
          : name === "NotFoundError"
            ? "No camera was found on this device."
            : name === "NotReadableError"
              ? "The camera is already in use by another app."
              : `Face tracker could not start (${name}).`;
      setStatus(reason);
    }
  }, [analyseFrame, cameras, findCameras, loadFaceDetector, selectedCamera, stopCamera]);

  const openMonitor = async () => {
    setScreen("monitor");
    setTimeout(startCamera, 0);
  };

  const plannedEvents = upcomingPlanEvents(medications, clock);
  const nextEvent = plannedEvents[0];
  const nextMeasurement = plannedEvents.find((event) => event.kind === "measurement");

  const applyMedicationPreset = (id: string) => {
    setSelectedPresetId(id);
    const preset = MEDICATION_PRESETS.find((item) => item.id === id);
    if (!preset) return;
    setMedicineName(preset.name);
    setMedicineActiveIngredient(preset.name);
    setMedicineChecks(preset.routineChecks);
    setDoseChange(false);
  };

  const setDoseChangePlan = (enabled: boolean) => {
    setDoseChange(enabled);
    const preset = MEDICATION_PRESETS.find((item) => item.id === selectedPresetId);
    if (preset) setMedicineChecks(enabled ? preset.changeChecks : preset.routineChecks);
  };

  const addMedication = async () => {
    if (!medicineName.trim()) return;
    const medication: Medication = {
      id: crypto.randomUUID(),
      name: medicineName.trim(),
      activeIngredient: medicineActiveIngredient.trim(),
      brand: medicineBrand.trim(),
      manufacturer: medicineManufacturer.trim(),
      dose: medicineDose.trim(),
      prescribedDirections: medicineDirections.trim(),
      purpose: medicinePurpose.trim(),
      prescriber: medicinePrescriber.trim(),
      startDate: medicineStartDate || undefined,
      photoDataUrl: medicinePhoto || undefined,
      time: medicineTime,
      checks: medicineChecks,
      doseChange,
      monitoringFrequency: MEDICATION_PRESETS.find((item) => item.id === selectedPresetId)?.monitoringFrequency,
      formulation: MEDICATION_PRESETS.find((item) => item.id === selectedPresetId)?.formulation,
      checkTiming: MEDICATION_PRESETS.find((item) => item.id === selectedPresetId)?.schedule,
      checkOffsetMinutes: (() => {
        const preset = MEDICATION_PRESETS.find((item) => item.id === selectedPresetId);
        if (!preset) return undefined;
        return doseChange ? preset.changeOffsets : preset.routineOffsets;
      })(),
      checkTimes: selectedPresetId === "custom" ? [medicineCheckTime] : undefined,
    };
    const next = [...medications, medication];
    setMedications(next);
    localStorage.setItem(MEDICATIONS_KEY, JSON.stringify(next));
    setMedicineName(""); setMedicineActiveIngredient(""); setMedicineBrand("");
    setMedicineManufacturer(""); setMedicineDose(""); setMedicineDirections("");
    setMedicinePurpose(""); setMedicinePrescriber(""); setMedicineStartDate("");
    setMedicinePhoto(""); setDoseChange(false); setSelectedPresetId("custom");
    setMedicineCheckTime("09:00"); setMedicineChecks(1);
    if ("Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission();
    }
  };

  const prepareMedicinePhoto = async (file?: File) => {
    if (!file) return;
    try {
      const bitmap = await createImageBitmap(file);
      const maximum = 720;
      const scale = Math.min(1, maximum / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      setMedicinePhoto(canvas.toDataURL("image/jpeg", 0.72));
      bitmap.close();
    } catch {
      setPatientNotice("That medicine photo could not be prepared. Try another image.");
    }
  };

  const addBloodPressure = () => {
    const systolic = Number(bpSystolic);
    const diastolic = Number(bpDiastolic);
    if (!Number.isFinite(systolic) || !Number.isFinite(diastolic) || systolic < 50 || systolic > 260 || diastolic < 30 || diastolic > 160) {
      setPatientNotice("Enter a valid blood pressure reading from your cuff.");
      return;
    }
    const next = [...bloodPressure, {
      id: crypto.randomUUID(), systolic, diastolic,
      timestamp: new Date().toISOString(), source: "Manual entry" as const,
    }];
    setBloodPressure(next);
    localStorage.setItem(BLOOD_PRESSURE_KEY, JSON.stringify(next));
    setBpSystolic(""); setBpDiastolic("");
    setPatientNotice(`Saved blood pressure ${systolic}/${diastolic} mmHg.`);
  };

  const addSymptom = () => {
    if (!symptomName.trim()) return;
    const next = [...symptoms, {
      id: crypto.randomUUID(), symptom: symptomName.trim(), severity: symptomSeverity,
      note: symptomNote.trim() || undefined, timestamp: new Date().toISOString(),
    }];
    setSymptoms(next);
    localStorage.setItem(SYMPTOMS_KEY, JSON.stringify(next));
    setSymptomName(""); setSymptomNote(""); setSymptomSeverity("Mild");
    setPatientNotice("Symptom added to your medication timeline.");
  };

  const removeMedication = (id: string) => {
    const medication = medications.find((item) => item.id === id);
    if (!window.confirm(`Remove ${medication?.name || "this medicine"} and its future reminders? Saved pulse readings will remain.`)) return;
    const next = medications.filter((medication) => medication.id !== id);
    setMedications(next);
    localStorage.setItem(MEDICATIONS_KEY, JSON.stringify(next));
    setPatientNotice(`${medication?.name || "Medicine"} was removed.`);
  };

  const logDose = (medication: Medication) => {
    const next = [...doses, {
      id: crypto.randomUUID(),
      medicationId: medication.id,
      medicationName: medication.name,
      timestamp: new Date().toISOString(),
    }];
    setDoses(next);
    localStorage.setItem(DOSES_KEY, JSON.stringify(next));
    setPatientNotice(`Dose recorded for ${medication.name} at ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`);
  };

  const readingContext = (date: Date) => {
    if (!doses.length) return "Routine check";
    const nearest = doses.reduce((best, dose) =>
      Math.abs(new Date(dose.timestamp).getTime() - date.getTime()) <
      Math.abs(new Date(best.timestamp).getTime() - date.getTime()) ? dose : best
    );
    const hours = (date.getTime() - new Date(nearest.timestamp).getTime()) / 3_600_000;
    if (Math.abs(hours) > 12) return "Routine check";
    return `${Math.abs(hours).toFixed(1)} h ${hours >= 0 ? "after" : "before"} ${nearest.medicationName}`;
  };

  const saveReadingAt = (bpmValue: number, date: Date) => {
    const context = readingContext(date);
    const next = [
      ...readings,
      {
        id: crypto.randomUUID(),
        bpm: Math.round(bpmValue * 10) / 10,
        timestamp: date.toISOString(),
        context,
      },
    ];
    setReadings(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return context;
  };

  const saveReading = () => {
    if (bpm === null) {
      setStatus("Wait for a confirmed measurement before saving");
      return;
    }
    // devTimeOffsetInput only has a UI to change it in dev mode and defaults
    // to "0", so this is a no-op for everyone else.
    const offsetMinutes = Number(devTimeOffsetInput) || 0;
    const recordedAt = new Date(Date.now() + offsetMinutes * 60_000);
    const context = saveReadingAt(bpm, recordedAt);
    setStatus(
      offsetMinutes
        ? `Measurement saved · ${context} (offset ${offsetMinutes > 0 ? "+" : ""}${offsetMinutes} min)`
        : `Measurement saved · ${context}`,
    );
  };

  const navigate = (next: Screen) => {
    if (screen === "monitor") stopCamera();
    setScreen(next);
  };

  const values = readings.map((reading) => reading.bpm);
  const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

  const recentReadings = [...readings]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, RECENT_READINGS_COUNT);

  const medicationResponses = medications.map((medication) => {
    const medicationDoses = doses.filter((dose) => dose.medicationId === medication.id);
    const offsets = DOSE_RESPONSE_OFFSETS_MINUTES.map((offsetMinutes) => {
      const reductions: number[] = [];
      medicationDoses.forEach((dose) => {
        const doseTime = new Date(dose.timestamp).getTime();
        const baseline = nearestReadingBefore(readings, doseTime, DOSE_BASELINE_WINDOW_MINUTES);
        const followUp = nearestReadingWithin(
          readings,
          doseTime + offsetMinutes * 60_000,
          DOSE_RESPONSE_TOLERANCE_MINUTES,
        );
        if (baseline && followUp) reductions.push(baseline.bpm - followUp.bpm);
      });
      return {
        offsetMinutes,
        sampleSize: reductions.length,
        averageReduction: reductions.length
          ? reductions.reduce((sum, value) => sum + value, 0) / reductions.length
          : null,
      };
    });
    return { medication, doseCount: medicationDoses.length, offsets };
  });

  const buildRawDataCsv = () => {
    const rows = [
      "PulseWindow monitoring summary",
      "Wellness estimates only - not a diagnosis or medical record",
      "",
      "CURRENT MEDICATION PLAN",
      "Medicine,Active ingredient,Brand,Manufacturer,Strength or dose,Pharmacy-label directions,Purpose,Prescriber,Formulation,Usual time,Start date",
      ...medications.map((medication) => [
        medication.name, medication.activeIngredient, medication.brand, medication.manufacturer,
        medication.dose, medication.prescribedDirections, medication.purpose, medication.prescriber,
        medication.formulation, medication.time, medication.startDate,
      ].map(csvCell).join(",")),
      "",
      "PULSE MEASUREMENTS",
      "Date,Time,BPM,Context,Source",
      ...readings.map((reading) => {
        const date = new Date(reading.timestamp);
        return [date.toLocaleDateString(), date.toLocaleTimeString(), reading.bpm,
          reading.context || "Routine check", "PulseWindow camera estimate"].map(csvCell).join(",");
      }),
      "",
      "DOSES TAKEN",
      "Date,Time,Medication",
      ...doses.map((dose) => {
        const date = new Date(dose.timestamp);
        return [date.toLocaleDateString(), date.toLocaleTimeString(), dose.medicationName].map(csvCell).join(",");
      }),
      "",
      "BLOOD PRESSURE",
      "Date,Time,Systolic,Diastolic,Unit,Source",
      ...bloodPressure.map((reading) => {
        const date = new Date(reading.timestamp);
        return [date.toLocaleDateString(), date.toLocaleTimeString(), reading.systolic,
          reading.diastolic, "mmHg", reading.source].map(csvCell).join(",");
      }),
      "",
      "SYMPTOMS",
      "Date,Time,Symptom,Severity,Notes",
      ...symptoms.map((entry) => {
        const date = new Date(entry.timestamp);
        return [date.toLocaleDateString(), date.toLocaleTimeString(), entry.symptom,
          entry.severity, entry.note].map(csvCell).join(",");
      }),
    ];
    return rows.join("\n");
  };

  const buildAnalyticalReportPdfBytes = (): ArrayBuffer => {
    const graphWidth = 1600;
    const graphHeight = 711;
    const graphCanvas = document.createElement("canvas");
    graphCanvas.width = graphWidth;
    graphCanvas.height = graphHeight;
    const graphContext = graphCanvas.getContext("2d")!;
    graphContext.fillStyle = "#ffffff";
    graphContext.fillRect(0, 0, graphWidth, graphHeight);
    drawPulseGraph(graphContext, graphWidth, graphHeight, recentReadings, doses);
    const graphImage = graphCanvas.toDataURL("image/png");

    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 15;
    const contentWidth = pageWidth - margin * 2;
    let y = margin;

    const addPageIfNeeded = (rowsNeeded: number) => {
      if (y + rowsNeeded > pageHeight - margin) {
        doc.addPage();
        y = margin;
      }
    };

    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.setTextColor(20);
    doc.text("PulseWindow — analytical summary", margin, y);
    y += 7;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(110);
    doc.text(
      `Generated ${new Date().toLocaleString()} · wellness estimates only, not a medical record`,
      margin,
      y,
    );
    doc.setTextColor(20);
    y += 10;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(`Recent readings (last ${recentReadings.length})`, margin, y);
    y += 4;

    if (recentReadings.length) {
      const imageHeight = (contentWidth * graphHeight) / graphWidth;
      doc.addImage(graphImage, "PNG", margin, y, contentWidth, imageHeight);
      y += imageHeight + 10;
    } else {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(11);
      doc.text("No measurements saved yet.", margin, y + 6);
      y += 14;
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text("Overview", margin, y);
    y += 7;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    if (readings.length) {
      doc.text(`Average heart rate: ${average.toFixed(0)} BPM`, margin, y);
      y += 6;
      doc.text(`Measurements: ${readings.length}`, margin, y);
      y += 6;
      doc.text(`Range: ${Math.min(...values).toFixed(0)}–${Math.max(...values).toFixed(0)} BPM`, margin, y);
      y += 10;
    } else {
      doc.text("No measurements saved yet.", margin, y);
      y += 10;
    }

    addPageIfNeeded(24);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text("Current medication plan", margin, y);
    y += 7;
    if (!medications.length) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.text("No medicines added yet.", margin, y);
      y += 9;
    }
    medications.forEach((medication) => {
      addPageIfNeeded(28);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.text(`${medication.name}${medication.dose ? ` — ${medication.dose}` : ""}`, margin, y);
      y += 5;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      const details = [
        medication.activeIngredient && `Active ingredient: ${medication.activeIngredient}`,
        (medication.brand || medication.manufacturer) && `Generic/brand: ${[medication.brand, medication.manufacturer].filter(Boolean).join(" · ")}`,
        medication.prescribedDirections && `Pharmacy directions: ${medication.prescribedDirections}`,
        medication.purpose && `Recorded reason: ${medication.purpose}`,
        medication.prescriber && `Prescriber: ${medication.prescriber}`,
        `Usual dose time: ${medication.time}`,
      ].filter(Boolean) as string[];
      details.forEach((detail) => {
        const lines = doc.splitTextToSize(detail, contentWidth - 3);
        addPageIfNeeded(lines.length * 4 + 2);
        doc.text(lines, margin + 2, y);
        y += lines.length * 4;
      });
      y += 3;
    });

    addPageIfNeeded(22);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text("Other observations", margin, y);
    y += 7;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.text(`Blood-pressure readings: ${bloodPressure.length}`, margin, y); y += 5;
    doc.text(`Symptoms recorded: ${symptoms.length}`, margin, y); y += 8;
    [...bloodPressure].slice(-5).forEach((reading) => {
      addPageIfNeeded(6);
      doc.text(`${new Date(reading.timestamp).toLocaleString()} · ${reading.systolic}/${reading.diastolic} mmHg · ${reading.source}`, margin + 2, y);
      y += 5;
    });
    [...symptoms].slice(-5).forEach((entry) => {
      addPageIfNeeded(7);
      const text = `${new Date(entry.timestamp).toLocaleString()} · ${entry.severity} ${entry.symptom}${entry.note ? ` · ${entry.note}` : ""}`;
      const lines = doc.splitTextToSize(text, contentWidth - 3);
      doc.text(lines, margin + 2, y);
      y += lines.length * 4 + 1;
    });

    addPageIfNeeded(18);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text("Response to medication", margin, y);
    y += 6;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text("Change in BPM vs. the reading before each dose.", margin, y);
    y += 9;
    doc.setTextColor(20);

    if (!medications.length) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(11);
      doc.text("No medicines added yet.", margin, y);
      y += 8;
    }

    medicationResponses.forEach(({ medication, doseCount, offsets }) => {
      addPageIfNeeded(26);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(12);
      doc.text(`${medication.name} — ${doseCount} dose${doseCount === 1 ? "" : "s"} logged`, margin, y);
      y += 6;

      if (doseCount === 0) {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(10);
        doc.setTextColor(110);
        doc.text("Log a dose to see its effect on pulse rate here.", margin + 2, y);
        doc.setTextColor(20);
        y += 10;
        return;
      }

      const columnWidth = contentWidth / offsets.length;
      offsets.forEach(({ offsetMinutes, averageReduction, sampleSize }, index) => {
        const columnX = margin + index * columnWidth;
        doc.setFont("helvetica", "bold");
        doc.setFontSize(10);
        doc.text(`${offsetMinutes} min`, columnX, y);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        const change = averageReduction === null ? null : -averageReduction;
        const changeText = change === null
          ? "no data"
          : `${change > 0 ? "+" : "-"}${Math.abs(change).toFixed(1)} bpm`;
        doc.text(changeText, columnX, y + 5);
        if (change !== null) {
          doc.setFontSize(7.5);
          doc.setTextColor(110);
          doc.text(`n=${sampleSize}`, columnX, y + 9.5);
          doc.setTextColor(20);
        }
      });
      y += 15;
    });

    addPageIfNeeded(10);
    doc.setFont("helvetica", "italic");
    doc.setFontSize(8);
    doc.setTextColor(110);
    doc.text(
      "Review estimates with a qualified healthcare professional. Do not change medication based on this app alone.",
      margin,
      y,
    );

    return doc.output("arraybuffer") as ArrayBuffer;
  };

  const exportSignedReport = async () => {
    if (!publicKey || !privateKey) {
      setShowKeySetup(true);
      return;
    }

    try {
      const reportBytes = buildAnalyticalReportPdfBytes();
      const csvBytes = new TextEncoder().encode(buildRawDataCsv()).buffer;
      const key = await importSigningPrivateKeyBase64(privateKey);
      // Sign both files together (report bytes then CSV bytes) so tampering
      // with either one after export breaks verification, not just the PDF.
      const signature = await signReportBytes(key, concatArrayBuffers(reportBytes, csvBytes));
      const entries: ExportEntry[] = [
        { path: "AnalyticalReport.pdf", data: reportBytes },
        { path: "Raw data.csv", data: csvBytes },
        { path: "DigitalSignature/hash.txt", data: signature },
        { path: "DigitalSignature/public.txt", data: publicKey },
      ];
      const folderName = `PulseWindowReporting-${formatDateTimeForFilename(new Date())}`;

      if (typeof window.showDirectoryPicker === "function") {
        const parentHandle = await window.showDirectoryPicker({ mode: "readwrite" });
        const rootHandle = await parentHandle.getDirectoryHandle(folderName, { create: true });
        for (const entry of entries) {
          await writeExportEntry(rootHandle, entry);
        }
        setPatientNotice(`Saved “${folderName}” to the folder you picked.`);
      } else {
        const zip = new JSZip();
        entries.forEach((entry) => zip.file(entry.path, entry.data));
        const zipBlob = await zip.generateAsync({ type: "blob" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(zipBlob);
        link.download = `${folderName}.zip`;
        link.click();
        URL.revokeObjectURL(link.href);
        setPatientNotice("Your browser can't save a folder directly, so this downloaded as a .zip instead.");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.error("Could not export the signed report", error);
      setPatientNotice("Could not export the report — check your saved keys and try again.");
    }
  };

  return (
    <main className="app-shell">
      {showKeySetup && keysLoaded && (
        <div className="key-setup-overlay" role="dialog" aria-modal="true" aria-label="Set up verification keys">
          <div className="key-setup-card">
            <p className="eyebrow">Pulse Window</p>
            <h1>Set up verification keys</h1>
            <p className="intro">
              Your clinic issued a public and private key for this device. Enter both to continue — they let a
              doctor confirm that an exported summary came from you unaltered. This is optional for daily use.
            </p>
            <div className="field">
              <label htmlFor="key-setup-public">Public key</label>
              <textarea
                id="key-setup-public"
                rows={3}
                value={keySetupPublicInput}
                onChange={(event) => setKeySetupPublicInput(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="key-setup-private">Private key</label>
              <textarea
                id="key-setup-private"
                rows={5}
                value={keySetupPrivateInput}
                onChange={(event) => setKeySetupPrivateInput(event.target.value)}
              />
            </div>
            {keySetupError && <p className="key-setup-error" role="alert">{keySetupError}</p>}
            <button className="primary" onClick={saveKeys} disabled={keySetupSaving}>
              {keySetupSaving ? "Checking…" : "Save and continue"}
            </button>
            <button className="secondary" onClick={() => setShowKeySetup(false)}>Not now</button>
          </div>
        </div>
      )}
      {screen === "start" && (
        <section className="dashboard-screen">
          <header className="dashboard-header">
            <div className="brand-mark" aria-hidden="true">♥</div>
            <div>
              <p className="eyebrow">Pulse Window</p>
              <h1>Today</h1>
              <p className="today-date">{clock.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}</p>
            </div>
          </header>

          <div className="task-heading">
            <h2>Your next step</h2>
            <p>PulseWindow puts the next planned action first.</p>
          </div>

          {patientNotice && <div className="patient-notice" role="status">✓ {patientNotice}</div>}

          {nextEvent && (
            <article className={`next-action-card ${nextEvent.kind === "measurement" ? "measurement-due" : ""}`}>
              <div className="next-action-icon" aria-hidden="true">{nextEvent.kind === "measurement" ? "♥" : "💊"}</div>
              <div className="next-action-copy">
                <p className="eyebrow">{relativePlanTime(nextEvent.date, clock)}</p>
                <h2>{nextEvent.label}</h2>
                <p>{nextEvent.date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · Based on the plan entered for {nextEvent.medication.name}</p>
              </div>
              {nextEvent.kind === "measurement"
                ? <button className="primary" onClick={openMonitor}>Start measurement</button>
                : <button className="primary" onClick={() => logDose(nextEvent.medication)}>Mark as taken</button>}
            </article>
          )}

          <article className="notification-card">
            <div><span className="notification-bell" aria-hidden="true">●</span><strong>Measurement reminders</strong><p>{notificationPermission === "granted" ? "On for this browser" : notificationPermission === "denied" ? "Blocked in browser settings" : "Not set up yet"}</p></div>
            {notificationPermission !== "granted" && <button className="secondary compact" onClick={enableNotifications}>Turn on reminders</button>}
            {notificationPermission === "granted" && <span className="notification-ok">✓ On</span>}
          </article>
          <p className="web-reminder-note">Web reminders work while this page is open. The iPhone app uses system notifications and can remind you when closed.</p>

          <div className="metric-grid" aria-label="Today at a glance">
            <article className="metric-card"><span>♥</span><div><strong>{readings.length ? Math.round(readings.at(-1)!.bpm) : "—"}</strong><small>Latest BPM</small></div></article>
            <article className="metric-card"><span>💊</span><div><strong>{medications.length}</strong><small>Medicines in your plan</small></div></article>
          </div>

          <div className="dashboard-grid">
            <article className="dashboard-card next-dose-card">
              <div className="section-title"><span>◷</span><strong>Next medication</strong></div>
              {medications.length ? (() => {
                const medication = [...medications].sort((a, b) => a.time.localeCompare(b.time))[0];
                return <>
                  <div className="dose-row">
                    <div><h2>{medication.name}</h2><p>{medication.dose || "Dose not entered"}</p><b>{medication.time}</b></div>
                  </div>
                  <p className="helper">Log the actual dose time so pulse readings can be shown before and after it.</p>
                  {medication.monitoringFrequency && <p className="monitoring-frequency">⌁ {medication.monitoringFrequency}</p>}
                  <p className="reminder-times">◷ Pulse reminders: {reminderTimeSummary(medication)}</p>
                  {medication.checkTiming && <p className="helper"><b>Suggested pulse-check timing:</b> {medication.checkTiming}</p>}
                  <button className="secondary dose-log-button" onClick={() => logDose(medication)}>✓ Log {medication.name} as taken</button>
                </>;
              })() : <><p>No medicine schedule yet.</p><button className="secondary" onClick={() => setScreen("medications")}>Add a medicine</button></>}
            </article>

            <article className="dashboard-card camera-card">
              <div className="section-title"><span>●</span><strong>Camera pulse check</strong></div>
              {nextMeasurement && <p className="next-check-line"><b>Next planned check:</b> {nextMeasurement.date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} for {nextMeasurement.medication.name}</p>}
              <p className="helper">Sit still in steady front lighting. Calibration takes 15 seconds, then the app confirms a stable estimate.</p>
              <label htmlFor="camera">Camera source</label>
              <div className="camera-row">
                <select id="camera" value={selectedCamera} onChange={(event) => setSelectedCamera(event.target.value)}>
                  {!cameras.length && <option value="">Default camera</option>}
                  {cameras.map((camera) => <option key={camera.deviceId} value={camera.deviceId}>{camera.label}</option>)}
                </select>
                <button className="secondary compact" onClick={findCameras}>Identify</button>
              </div>
              <button className="primary" onClick={openMonitor}>Start pulse measurement</button>
            </article>
          </div>

          <nav className="dashboard-nav" aria-label="Main navigation">
            <button className="active" aria-current="page">⌂ <span>Today</span></button>
            <button onClick={() => setScreen("medications")}>● <span>Medicines</span></button>
            <button onClick={() => setScreen("history")}>⌁ <span>History</span></button>
          </nav>
          <p className="disclaimer">Wellness prototype only. Follow medication instructions from your clinician or pharmacist.</p>
        </section>
      )}

      {screen === "monitor" && (
        <section className="monitor-screen">
          <header className="topbar">
            <button className="text-button" onClick={() => navigate("start")}>← Home</button>
            <span>Live monitor</span>
            <button className="text-button" onClick={() => navigate("history")}>History</button>
          </header>

          <div className="camera-stage">
            <video ref={videoRef} playsInline muted />
            <canvas
              ref={diagnosticCanvasRef}
              width="320"
              height="240"
              className={`diagnostic-canvas ${developerMode ? "visible" : ""}`}
              aria-label="Green-channel developer camera view"
            />
            <div
              className={`face-guide ${faceBox ? "tracked" : ""}`}
              style={faceBox ? {
                left: `${((320 - faceBox.x - faceBox.width) / 320) * 100}%`,
                top: `${(faceBox.y / 240) * 100}%`,
                width: `${(faceBox.width / 320) * 100}%`,
                height: `${(faceBox.height / 240) * 100}%`,
              } : undefined}
              aria-hidden="true"
            >
              <span>{faceBox ? "Face tracked" : "Look toward the camera"}</span>
            </div>
            {developerMode && (
              <div className="developer-label">
                Amplified green change · green ↑ · purple ↓
              </div>
            )}
          </div>
          <canvas ref={workCanvasRef} width="320" height="240" hidden />

          <div className="reading-panel">
            <div
              key={beatSync.revision}
              className={`heart-pulse ${bpm && monitoring ? "active" : ""}`}
              style={{
                animationDuration: bpm ? `${60 / bpm}s` : "1s",
                animationDelay: bpm ? `-${beatSync.age}s` : "0s",
              }}
              title="Aligned to the estimated webcam pulse waveform"
              aria-hidden="true"
            >♥</div>
            <div className="bpm-block">
              <strong>{bpm === null ? "--" : Math.round(bpm)}</strong>
              <span>BPM</span>
            </div>
            {calibrationSeconds !== null && (
              <div className="calibration-card" aria-live="polite">
                <div>
                  <strong>Calibrating</strong>
                  <span>{calibrationSeconds} {calibrationSeconds === 1 ? "second" : "seconds"}</span>
                </div>
                <div className="calibration-track" aria-hidden="true">
                  <span
                    style={{
                      width: `${((INITIAL_CALIBRATION_SECONDS - calibrationSeconds) / INITIAL_CALIBRATION_SECONDS) * 100}%`,
                    }}
                  />
                </div>
              </div>
            )}
            <p className="status" aria-live="polite">{status}</p>
          </div>

          <div className="monitor-actions">
            {monitoring ? (
              <button className="danger" onClick={stopCamera}>Stop measurement</button>
            ) : (
              <button className="primary" onClick={startCamera}>Start again</button>
            )}
            <button className="secondary" onClick={saveReading}>Save measurement</button>
          </div>
          <button
            className={`developer-toggle ${developerMode ? "enabled" : ""}`}
            onClick={toggleDeveloperMode}
            aria-pressed={developerMode}
          >
            {developerMode ? "Hide amplified green changes" : "Show amplified green changes"}
          </button>
          {DEV_MODE && (
            <div className="dev-mode-panel">
              <span className="dev-mode-badge">Dev mode</span>
              <label htmlFor="simulate-bpm">Simulate a BPM reading (no camera)</label>
              <div className="camera-row">
                <input
                  id="simulate-bpm"
                  type="number"
                  min={MIN_BPM}
                  max={MAX_BPM}
                  placeholder={`${MIN_BPM}-${MAX_BPM}`}
                  value={simulatedBpmInput}
                  onChange={(event) => setSimulatedBpmInput(event.target.value)}
                />
                <button className="secondary compact" onClick={applySimulatedBpm}>Simulate</button>
              </div>
              <label htmlFor="dev-time-offset">Time offset (minutes)</label>
              <input
                id="dev-time-offset"
                type="number"
                step={1}
                value={devTimeOffsetInput}
                onChange={(event) => setDevTimeOffsetInput(event.target.value)}
              />
              <p className="helper">
                Added to the current time when you hit “Save measurement” below — e.g. set to 30 to record the
                next save as 30 minutes from now, without waiting.
              </p>
            </div>
          )}
        </section>
      )}

      {screen === "medications" && (
        <section className="medications-screen">
          <header className="topbar">
            <button className="text-button" onClick={() => navigate("start")}>← Today</button>
            <span>Medicines</span>
            <button className="text-button" onClick={() => navigate("history")}>History</button>
          </header>
          <div className="medications-content">
            <div className="page-heading">
              <p className="eyebrow">Your care plan</p>
              <h2>Medicines and pulse checks</h2>
              <p>Enter only schedules provided by your healthcare professional.</p>
            </div>

            {patientNotice && <div className="patient-notice" role="status">✓ {patientNotice}</div>}

            <h3 className="subsection-heading">Your medicines</h3>
            <div className="medicine-list">
              {medications.length === 0 && <div className="empty-card"><span>💊</span><h3>No medicines yet</h3><p>Use “Add a medicine” below to create your monitoring plan.</p></div>}
              {medications.map((medication) => (
                <article className="medicine-card" key={medication.id}>
                  <div className="medicine-card-layout">
                    {medication.photoDataUrl
                      ? <img className="medicine-photo" src={medication.photoDataUrl} alt={`${medication.name} packaging or tablet`} />
                      : <div className="medicine-photo-placeholder" aria-label="No medicine photo">💊</div>}
                    <div className="medicine-card-body">
                      <div className="medicine-card-head"><div><h3>{medication.name}</h3><p>{medication.dose || "Strength or dose not entered"}</p></div><strong>{medication.time}</strong></div>
                      {medication.activeIngredient && medication.activeIngredient.toLowerCase() !== medication.name.toLowerCase() && <p><b>Active ingredient:</b> {medication.activeIngredient}</p>}
                      {(medication.brand || medication.manufacturer) && <p><b>Generic/brand:</b> {[medication.brand, medication.manufacturer].filter(Boolean).join(" · ")}</p>}
                      {medication.prescribedDirections && <p className="directions"><b>Pharmacy directions:</b> {medication.prescribedDirections}</p>}
                      {medication.purpose && <p><b>Reason:</b> {medication.purpose}</p>}
                      {medication.prescriber && <p><b>Prescriber:</b> {medication.prescriber}</p>}
                      <p>⌁ {medication.checks} planned pulse check{medication.checks === 1 ? "" : "s"} daily</p>
                      {medication.monitoringFrequency && <p className="monitoring-frequency">{medication.monitoringFrequency}</p>}
                      <p className="reminder-times">◷ Reminder times: {reminderTimeSummary(medication)}</p>
                      {medication.formulation && <p><b>Formulation:</b> {medication.formulation}</p>}
                      {medication.checkTiming && <p className="check-timing"><b>Suggested pulse-check timing:</b> {medication.checkTiming}</p>}
                      {medication.doseChange && <p className="dose-change">↻ Dose-change monitoring enabled</p>}
                      <div className="card-actions"><button className="secondary" onClick={() => logDose(medication)}>✓ Log dose as taken</button><button className="delete-button" onClick={() => removeMedication(medication.id)}>Remove medicine</button></div>
                    </div>
                  </div>
                </article>
              ))}
            </div>

            <details className="add-medicine-panel" open={medications.length === 0 ? true : undefined}>
              <summary>＋ Add a medicine</summary>
              <div className="add-medicine-content">
                <div className="preset-panel">
                  <h3>Choose a medicine template</h3>
                  <p className="helper">Select a medicine to fill its monitoring intervals. Confirm the plan with a clinician or pharmacist.</p>
                  <div className="preset-list">
                    {MEDICATION_PRESETS.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        className={`preset-card ${selectedPresetId === preset.id ? "selected" : ""}`}
                        onClick={() => applyMedicationPreset(preset.id)}
                      >
                        <strong>{preset.name}</strong>
                        <span className="preset-frequency">{preset.monitoringFrequency}</span>
                        <span>{preset.formulation}</span>
                        <span>{preset.schedule}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <form className="medicine-form" onSubmit={(event) => { event.preventDefault(); void addMedication(); }}>
                  <h3>Check the medicine details</h3>
                  <div className="form-grid">
                    <label>Medicine template<select value={selectedPresetId} onChange={(event) => applyMedicationPreset(event.target.value)}>
                      <option value="custom">Custom</option>
                      {MEDICATION_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
                    </select></label>
                    <label>Name shown on the pharmacy label<input value={medicineName} onChange={(event) => setMedicineName(event.target.value)} placeholder="e.g. APO-Metoprolol" required /></label>
                    <label>Active ingredient<input value={medicineActiveIngredient} onChange={(event) => setMedicineActiveIngredient(event.target.value)} placeholder="e.g. metoprolol" /></label>
                    <label>Brand or generic prefix<input value={medicineBrand} onChange={(event) => setMedicineBrand(event.target.value)} placeholder="e.g. APO, Sandoz" /></label>
                    <label>Manufacturer<input value={medicineManufacturer} onChange={(event) => setMedicineManufacturer(event.target.value)} placeholder="e.g. Apotex" /></label>
                    <label>Strength or dose<input value={medicineDose} onChange={(event) => setMedicineDose(event.target.value)} placeholder="e.g. 25 mg" /></label>
                    <label>Pharmacy-label directions<input value={medicineDirections} onChange={(event) => setMedicineDirections(event.target.value)} placeholder="e.g. Take one tablet each morning" /></label>
                    <label>Reason for taking it<input value={medicinePurpose} onChange={(event) => setMedicinePurpose(event.target.value)} placeholder="e.g. heart rhythm" /></label>
                    <label>Prescriber<input value={medicinePrescriber} onChange={(event) => setMedicinePrescriber(event.target.value)} placeholder="e.g. Dr Smith" /></label>
                    <label>Start date<input type="date" value={medicineStartDate} onChange={(event) => setMedicineStartDate(event.target.value)} /></label>
                    <label>Usual dose time<input type="time" value={medicineTime} onChange={(event) => setMedicineTime(event.target.value)} /></label>
                    {selectedPresetId === "custom"
                      ? <label>Daily measurement time confirmed by clinician<input type="time" value={medicineCheckTime} onChange={(event) => { setMedicineCheckTime(event.target.value); setMedicineChecks(1); }} /></label>
                      : <div className="form-plan-summary"><span>Planned checks</span><b>{medicineChecks} each day</b></div>}
                  </div>
                  <label className="photo-field">
                    <span>Photo of the packaging or tablet</span>
                    <input type="file" accept="image/*" capture="environment" onChange={(event) => void prepareMedicinePhoto(event.target.files?.[0])} />
                  </label>
                  {medicinePhoto && <div className="photo-preview"><img src={medicinePhoto} alt="Preview of the medicine being added" /><button type="button" className="text-button" onClick={() => setMedicinePhoto("")}>Remove photo</button></div>}
                  <p className="helper">Use the pharmacy label as the source of truth. A photo helps recognition but cannot confirm a medicine’s identity.</p>
                  <label className="toggle-row"><input type="checkbox" checked={doseChange} onChange={(event) => setDoseChangePlan(event.target.checked)} /> Extra monitoring during a dose change or loading period</label>
                  {selectedPresetId !== "custom" && (() => {
                    const preset = MEDICATION_PRESETS.find((item) => item.id === selectedPresetId);
                    const offsets = doseChange ? preset?.changeOffsets : preset?.routineOffsets;
                    return preset && offsets ? <div className="selected-schedule"><b>{preset.monitoringFrequency}</b><span>{preset.formulation}</span><span>{preset.schedule}</span><strong>Reminder times: {reminderTimesFor(medicineTime, offsets)}</strong></div> : null;
                  })()}
                  <p className="helper">These are pulse-check reminders, not instructions for taking medicine. Turn on extra monitoring only when your clinician requested it.</p>
                  <button className="primary" type="submit">Save medicine and enable reminders</button>
                </form>
              </div>
            </details>
            <p className="disclaimer">Reminders support an existing care plan; they do not recommend when or how often to take medication.</p>
          </div>
          <nav className="dashboard-nav" aria-label="Main navigation">
            <button onClick={() => navigate("start")}>⌂ <span>Today</span></button>
            <button className="active" aria-current="page">● <span>Medicines</span></button>
            <button onClick={() => navigate("history")}>⌁ <span>History</span></button>
          </nav>
        </section>
      )}

      {screen === "history" && (
        <section className="history-screen">
          <header className="topbar">
            <button className="text-button" onClick={() => navigate("start")}>← Today</button>
            <span>History</span>
            <button className="text-button" onClick={() => navigate("medications")}>Medicines</button>
          </header>
          <div className="history-content">
            <h2>Pulse and medication timeline</h2>
            <p>Review doses, camera pulse estimates, cuff readings and symptoms together. Data stays on this device.</p>
            {!!readings.length && (
              <div className="summary-strip">
                <span><b>{readings.length}</b> measurements</span>
                <span><b>{average.toFixed(0)}</b> average BPM</span>
                <span><b>{Math.min(...values).toFixed(0)}–{Math.max(...values).toFixed(0)}</b> BPM range</span>
              </div>
            )}
            <div className="graph-heading">
              <strong>Monitoring history</strong>
              <span>Pulse rate (BPM)</span>
            </div>
            <HistoryGraph readings={readings} doses={doses} />
            <section className="observation-grid" aria-label="Add observations">
              <article className="observation-card">
                <h3>Add blood pressure</h3>
                <p>Enter a reading from a validated upper-arm cuff.</p>
                <div className="compact-fields">
                  <label>Systolic<input inputMode="numeric" type="number" value={bpSystolic} onChange={(event) => setBpSystolic(event.target.value)} placeholder="120" /></label>
                  <label>Diastolic<input inputMode="numeric" type="number" value={bpDiastolic} onChange={(event) => setBpDiastolic(event.target.value)} placeholder="80" /></label>
                </div>
                <button className="secondary" onClick={addBloodPressure}>Save cuff reading</button>
              </article>
              <article className="observation-card">
                <h3>Add a symptom</h3>
                <p>Record what you noticed; this does not diagnose the cause.</p>
                <label>Symptom<input value={symptomName} onChange={(event) => setSymptomName(event.target.value)} placeholder="e.g. dizziness" /></label>
                <label>How noticeable<select value={symptomSeverity} onChange={(event) => setSymptomSeverity(event.target.value as SymptomEntry["severity"])}><option>Mild</option><option>Moderate</option><option>Severe</option></select></label>
                <label>Optional note<input value={symptomNote} onChange={(event) => setSymptomNote(event.target.value)} placeholder="What were you doing?" /></label>
                <button className="secondary" onClick={addSymptom}>Add to timeline</button>
              </article>
            </section>
            <section className="unified-timeline" aria-labelledby="timeline-heading">
              <div className="graph-heading"><strong id="timeline-heading">Medication timeline</strong><span>Newest first</span></div>
              {[...readings.map((item) => ({ id: item.id, timestamp: item.timestamp, icon: "♥", title: `${item.bpm.toFixed(0)} BPM`, detail: `${item.context || "Routine check"} · PulseWindow camera estimate` })),
                ...doses.map((item) => ({ id: item.id, timestamp: item.timestamp, icon: "💊", title: `${item.medicationName} taken`, detail: "Dose logged by patient" })),
                ...bloodPressure.map((item) => ({ id: item.id, timestamp: item.timestamp, icon: "⌁", title: `${item.systolic}/${item.diastolic} mmHg`, detail: item.source })),
                ...symptoms.map((item) => ({ id: item.id, timestamp: item.timestamp, icon: "●", title: `${item.severity} ${item.symptom}`, detail: item.note || "Symptom recorded by patient" }))]
                .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
                .slice(0, 30)
                .map((item) => <article key={`${item.icon}-${item.id}`}><span className="timeline-icon" aria-hidden="true">{item.icon}</span><div><strong>{item.title}</strong><p>{item.detail}</p><time dateTime={item.timestamp}>{new Date(item.timestamp).toLocaleString()}</time></div></article>)}
              {!readings.length && !doses.length && !bloodPressure.length && !symptoms.length && <div className="empty-card"><p>No timeline entries yet.</p></div>}
            </section>
            <div className="export-actions">
              <button className="secondary" onClick={exportSignedReport}>Export report</button>
            </div>
            <div className="graph-heading">
              <strong>Every measurement</strong>
            </div>
            <div className="reading-list">
              {[...readings]
                .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
                .map((reading) => (
                <article key={reading.id}>
                  <div className="saved-time">
                    <time dateTime={reading.timestamp}>
                      {new Date(reading.timestamp).toLocaleDateString(undefined, {
                        weekday: "short",
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                    </time>
                    <span>{new Date(reading.timestamp).toLocaleTimeString(undefined, {
                      hour: "numeric",
                      minute: "2-digit",
                    })}</span>
                    <small>{reading.context || "Routine check"}</small>
                  </div>
                  <strong>{reading.bpm.toFixed(0)} <small>BPM</small></strong>
                </article>
              ))}
            </div>
            <p className="disclaimer">Review estimates with a qualified healthcare professional. Do not change medication based on this app alone.</p>
          </div>
          <nav className="dashboard-nav" aria-label="Main navigation">
            <button onClick={() => navigate("start")}>⌂ <span>Today</span></button>
            <button onClick={() => navigate("medications")}>● <span>Medicines</span></button>
            <button className="active" aria-current="page">⌁ <span>History</span></button>
          </nav>
        </section>
      )}
    </main>
  );
}

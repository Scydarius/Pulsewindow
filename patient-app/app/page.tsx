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
import Alert from "@mui/material/Alert";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import BottomNavigation from "@mui/material/BottomNavigation";
import BottomNavigationAction from "@mui/material/BottomNavigationAction";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardActions from "@mui/material/CardActions";
import CardContent from "@mui/material/CardContent";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import Container from "@mui/material/Container";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import InputLabel from "@mui/material/InputLabel";
import LinearProgress from "@mui/material/LinearProgress";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import MedicalServicesIcon from "@mui/icons-material/MedicalServices";
import MedicationIcon from "@mui/icons-material/Medication";
import BarChartIcon from "@mui/icons-material/BarChart";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import PhotoCameraIcon from "@mui/icons-material/PhotoCamera";
import AddIcon from "@mui/icons-material/Add";
import AlarmIcon from "@mui/icons-material/Alarm";
import AutorenewIcon from "@mui/icons-material/Autorenew";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import NotificationsIcon from "@mui/icons-material/Notifications";
import RepeatIcon from "@mui/icons-material/Repeat";

type Screen = "vitals" | "medicine" | "data" | "caregiver";
type Camera = { deviceId: string; label: string };
type MeasurementMetric = "heartRate" | "respiratoryRate";
type Reading = { id: string; bpm: number; respiratoryRate?: number | null; timestamp: string; context?: string };
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
  measurementMetrics?: MeasurementMetric[];
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
  kind: "measurement";
  date: Date;
  medication: Medication;
  label: string;
};
type DoctorMeasurementPlan = {
  version: 1;
  planId: string;
  patientLabel?: string;
  medicationName: string;
  metrics: MeasurementMetric[];
  times: string[];
  clinician?: string;
  note?: string;
  createdAt: string;
};
type CaregiverSnapshot = {
  version: 1;
  generatedAt: string;
  medications: Array<Pick<Medication, "name" | "dose" | "prescribedDirections" | "measurementMetrics">>;
  readings: Reading[];
  doses: DoseEvent[];
  bloodPressure: BloodPressureReading[];
  symptoms: SymptomEntry[];
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

// Breathing is much slower than heart rate (roughly 0.1-0.5 Hz vs 0.75-3 Hz),
// so resolving it needs a longer observation window than the pulse signal.
const MIN_RESPIRATION_RATE = 6;
const MAX_RESPIRATION_RATE = 30;
const RESPIRATION_WINDOW_SECONDS = 60;
const MIN_RESPIRATION_QUALITY = 0.25;

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
  if (!preset) return { ...medication, measurementMetrics: medication.measurementMetrics ?? ["heartRate"] };
  return {
    ...medication,
    monitoringFrequency: preset.monitoringFrequency,
    formulation: preset.formulation,
    checkTiming: preset.schedule,
    checkOffsetMinutes: medication.doseChange ? preset.changeOffsets : preset.routineOffsets,
    measurementMetrics: medication.measurementMetrics ?? ["heartRate"],
  };
}

// Decodes a base64url "plan code" produced by the doctor portal's matching
// encodePortable helper (no server round trip involved).
function decodePortable<T>(code: string): T {
  const base64 = code.trim().replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)))) as T;
}

function measurementName(metrics: MeasurementMetric[] | undefined) {
  const selected = metrics?.length ? metrics : ["heartRate"];
  if (selected.includes("heartRate") && selected.includes("respiratoryRate")) return "Heart and breathing-rate measurement";
  if (selected.includes("respiratoryRate")) return "Breathing-rate measurement";
  return "Heart-rate measurement";
}

function csvCell(value: string | number | undefined): string {
  const text = value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
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

// Computes the next couple of days' worth of planned measurement times (not
// dose-taking reminders — those are separate) so the dashboard can surface
// "what's next" instead of a generic medicine list.
function upcomingPlanEvents(medications: Medication[], now: Date): PlannedEvent[] {
  const events: PlannedEvent[] = [];
  medications.forEach((medication) => {
    const [hour, minute] = medication.time.split(":").map(Number);
    for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
      const doseDate = new Date(now);
      doseDate.setDate(now.getDate() + dayOffset);
      doseDate.setHours(hour, minute, 0, 0);
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
          label: `${measurementName(medication.measurementMetrics)} for ${medication.name}`,
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

// Breathing shows up as a slow-moving component riding on top of the same
// facial colour signal used for heart rate — a mix of respiratory sinus
// arrhythmia and respiratory-induced intensity variation. Unlike estimateBPM
// (which uses a CHROM-style projection tuned to isolate the ~1-3 Hz cardiac
// band), this tracks the green channel directly — it's the most
// PPG-sensitive channel — over a much longer window, linearly detrends it,
// and searches for the dominant frequency in the breathing band.
function estimateRespiratoryRate(samples: Sample[]) {
  if (
    samples.length < 200 ||
    samples.at(-1)!.time - samples[0].time < RESPIRATION_WINDOW_SECONDS * 0.66
  ) {
    return null;
  }

  const fps = 6;
  const colours = interpolateSamples(samples, fps);
  if (colours.length < 60) return null;

  const green = colours.map((colour) => colour[1]);
  const meanIndex = (green.length - 1) / 2;
  const meanValue = green.reduce((sum, value) => sum + value, 0) / green.length;
  let sumSquaredOffsets = 0;
  let sumOffsetDeviation = 0;
  green.forEach((value, index) => {
    const offset = index - meanIndex;
    sumSquaredOffsets += offset * offset;
    sumOffsetDeviation += offset * (value - meanValue);
  });
  const slope = sumSquaredOffsets > 0 ? sumOffsetDeviation / sumSquaredOffsets : 0;
  const detrended = green.map((value, index) => value - meanValue - slope * (index - meanIndex));

  const powers: { rate: number; power: number }[] = [];
  for (let rate = MIN_RESPIRATION_RATE; rate <= MAX_RESPIRATION_RATE; rate += 0.5) {
    const frequency = rate / 60;
    let real = 0;
    let imaginary = 0;
    detrended.forEach((value, index) => {
      const angle = (2 * Math.PI * frequency * index) / fps;
      const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / Math.max(1, detrended.length - 1));
      real += value * hann * Math.cos(angle);
      imaginary -= value * hann * Math.sin(angle);
    });
    powers.push({ rate, power: real ** 2 + imaginary ** 2 });
  }

  const peak = powers.reduce((best, item) => (item.power > best.power ? item : best));
  const total = powers.reduce((sum, item) => sum + item.power, 0);
  const local = powers
    .filter((item) => Math.abs(item.rate - peak.rate) <= 2)
    .reduce((sum, item) => sum + item.power, 0);
  return { rate: peak.rate, quality: total > 0 ? local / total : 0 };
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

type GraphMetric = {
  getValue: (reading: Reading) => number | null | undefined;
  axisFloor: number;
  axisCeil: number;
  minSpan: number;
  padding: number;
  lineColor: string;
  fillColorStart: string;
  fillColorEnd: string;
  pointColor: string;
  latestColor: string;
};

const BPM_GRAPH_METRIC: GraphMetric = {
  getValue: (reading) => reading.bpm,
  axisFloor: 30,
  axisCeil: 200,
  minSpan: 30,
  padding: 20,
  lineColor: "#19764a",
  fillColorStart: "rgba(25, 118, 74, .20)",
  fillColorEnd: "rgba(25, 118, 74, 0)",
  pointColor: "#19764a",
  latestColor: "#df3b3b",
};

const RESPIRATION_GRAPH_METRIC: GraphMetric = {
  getValue: (reading) => reading.respiratoryRate,
  axisFloor: 0,
  axisCeil: 40,
  minSpan: 8,
  padding: 4,
  lineColor: "#1c6f8c",
  fillColorStart: "rgba(28, 111, 140, .20)",
  fillColorEnd: "rgba(28, 111, 140, 0)",
  pointColor: "#1c6f8c",
  latestColor: "#df3b3b",
};

function drawPulseGraph(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  readings: Reading[],
  doses: DoseEvent[],
  metric: GraphMetric,
  fontScale = 1,
) {
  context.clearRect(0, 0, width, height);
  const usable = readings
    .map((reading) => ({ reading, value: metric.getValue(reading) }))
    .filter((entry): entry is { reading: Reading; value: number } => entry.value !== null && entry.value !== undefined)
    .sort((a, b) => new Date(a.reading.timestamp).getTime() - new Date(b.reading.timestamp).getTime());
  if (!usable.length) return;

  const values = usable.map((entry) => entry.value);
  const times = usable.map((entry) => new Date(entry.reading.timestamp).getTime());
  const timeStart = Math.min(...times);
  const timeEnd = Math.max(...times);
  const timeSpan = Math.max(1, timeEnd - timeStart);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const valueSpan = Math.max(metric.minSpan, high - low + metric.padding);
  const middle = (low + high) / 2;
  const yMin = Math.max(metric.axisFloor, middle - valueSpan / 2);
  const yMax = Math.min(metric.axisCeil, middle + valueSpan / 2);
  const margin = { left: 48, right: 20, top: 22, bottom: 50 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const x = (index: number) =>
    usable.length === 1
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
    context.font = `bold ${Math.round(11 * fontScale)}px system-ui`;
    context.textAlign = "left";
    context.fillText(`💊 ${dose.medicationName}`, Math.min(doseX + 4, width - 100), margin.top + 4);
  });

  context.font = `${Math.round(12 * fontScale)}px system-ui`;
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
    const tickTime = usable.length === 1 ? times[0] : timeStart + fraction * timeSpan;
    context.strokeStyle = "#edf2ef";
    context.beginPath();
    context.moveTo(tickX, margin.top);
    context.lineTo(tickX, margin.top + plotHeight);
    context.stroke();
    context.fillStyle = "#607069";
    context.textAlign = tick === 0 ? "left" : tick === 2 ? "right" : "center";
    context.fillText(axisFormatter.format(new Date(tickTime)), tickX, height - 28);
  }

  if (usable.length > 1) {
    const gradient = context.createLinearGradient(0, margin.top, 0, margin.top + plotHeight);
    gradient.addColorStop(0, metric.fillColorStart);
    gradient.addColorStop(1, metric.fillColorEnd);
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

    context.strokeStyle = metric.lineColor;
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
    context.fillStyle = index === values.length - 1 ? metric.latestColor : metric.pointColor;
    context.beginPath();
    context.arc(x(index), y(value), 5, 0, 2 * Math.PI);
    context.fill();
  });
}

function HistoryGraph({
  readings,
  doses,
  metric,
  emptyMessage,
  ariaLabel,
}: {
  readings: Reading[];
  doses: DoseEvent[];
  metric: GraphMetric;
  emptyMessage: string;
  ariaLabel: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hasData = readings.some((reading) => metric.getValue(reading) !== null && metric.getValue(reading) !== undefined);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !hasData) return;

    const draw = () => {
      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      const context = canvas.getContext("2d")!;
      context.scale(ratio, ratio);
      drawPulseGraph(context, width, height, readings, doses, metric);
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [readings, doses, metric, hasData]);

  if (!hasData) return <div className="empty-history">{emptyMessage}</div>;
  return <canvas className="history-graph" ref={canvasRef} role="img" aria-label={ariaLabel} />;
}

export default function Home() {
  const [screen, setScreen] = useState<Screen>("vitals");
  const [vitalsActive, setVitalsActive] = useState(false);
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [selectedCamera, setSelectedCamera] = useState("");
  const [monitoring, setMonitoring] = useState(false);
  const [bpm, setBpm] = useState<number | null>(null);
  const [respiratoryRate, setRespiratoryRate] = useState<number | null>(null);
  const [status, setStatus] = useState("Ready to measure");
  const [calibrationSeconds, setCalibrationSeconds] = useState<number | null>(null);
  const [beatSync, setBeatSync] = useState({ age: 0, revision: 0 });
  const [developerMode, setDeveloperMode] = useState(false);
  const [simulatedBpmInput, setSimulatedBpmInput] = useState("");
  const [simulatedRespiratoryInput, setSimulatedRespiratoryInput] = useState("");
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
  const [planCode, setPlanCode] = useState("");
  const [caregiverSnapshot, setCaregiverSnapshot] = useState<CaregiverSnapshot | null>(null);
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
  const respiratorySamplesRef = useRef<Sample[]>([]);
  const candidatesRef = useRef<number[]>([]);
  const pendingJumpRef = useRef<number[]>([]);
  const lastEstimateRef = useRef(0);
  const bpmRef = useRef<number | null>(null);
  const respiratoryRateRef = useRef<number | null>(null);
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
                body: `Time for the planned resting pulse check for ${medication.name}. Use the plan confirmed by your clinician.`,
              };
            })
          : medicationCheckOffsets(medication).map((offset) => ({
              target: (doseMinutes + offset + 1440) % 1440,
              body: `${reminderTiming(offset)} for ${medication.name}. Use the plan confirmed by your clinician.`,
            }));
        // Measurement checks only — dose-taking reminders were removed so
        // this can never be mistaken for medical advice about when to dose.
        const reminders = measurementReminders.map((reminder) => ({
          ...reminder,
          title: measurementName(medication.measurementMetrics),
          body: `${reminder.body.replace("pulse check", "measurement")} ${measurementName(medication.measurementMetrics)} only — this is not a reminder to take medicine.`,
        }));
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
    respiratorySamplesRef.current = [];
    respiratoryRateRef.current = null;
    candidatesRef.current = [];
    pendingJumpRef.current = [];
    unstableUntilRef.current = 0;
    lastBrightnessRef.current = null;
    pauseStartedRef.current = null;
    sampleOffsetsRef.current = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    setFaceBox(null);
    setCalibrationSeconds(null);
    setMonitoring(false);
    setRespiratoryRate(null);
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
    let respiratoryValue: number | null = null;
    if (simulatedRespiratoryInput.trim() !== "") {
      const parsed = Number(simulatedRespiratoryInput);
      if (!Number.isFinite(parsed) || parsed < MIN_RESPIRATION_RATE || parsed > MAX_RESPIRATION_RATE) {
        setStatus(`Enter a respiratory rate between ${MIN_RESPIRATION_RATE} and ${MAX_RESPIRATION_RATE}`);
        return;
      }
      respiratoryValue = parsed;
    }
    stopCamera();
    bpmRef.current = value;
    setBpm(value);
    respiratoryRateRef.current = respiratoryValue;
    setRespiratoryRate(respiratoryValue);
    setMonitoring(true);
    setCalibrationSeconds(null);
    setBeatSync((current) => ({ age: 0, revision: current.revision + 1 }));
    setStatus("Simulated reading — not from camera");
  };

  const wipeAllData = () => {
    if (!window.confirm("Wipe all readings, medicines, and doses? This can't be undone.")) return;
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(MEDICATIONS_KEY);
    localStorage.removeItem(DOSES_KEY);
    setReadings([]);
    setMedications([]);
    setDoses([]);
    bpmRef.current = null;
    respiratoryRateRef.current = null;
    setBpm(null);
    setRespiratoryRate(null);
    setStatus("Dev mode — all data wiped");
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
          respiratorySamplesRef.current = [];
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
        respiratorySamplesRef.current = respiratorySamplesRef.current.map((sample) => ({
          ...sample,
          time: sample.time + pauseSeconds,
        }));
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
      const combinedForRespiratory: RGB = [0, 1, 2].map((channel) =>
        median(correctedColours.map((colour) => colour[channel])),
      ) as RGB;
      respiratorySamplesRef.current = [
        ...respiratorySamplesRef.current,
        { time: now, rgb: combinedForRespiratory },
      ].filter((sample) => now - sample.time <= RESPIRATION_WINDOW_SECONDS + 0.5);
      const duration = now - regionSamplesRef.current[0][0].time;
      if (duration < INITIAL_CALIBRATION_SECONDS - 0.5) {
        const remaining = Math.max(1, Math.ceil(INITIAL_CALIBRATION_SECONDS - duration));
        setCalibrationSeconds(remaining);
        setStatus("Keep still while the signal builds");
      }
      else if (now - lastEstimateRef.current >= 1) {
        setCalibrationSeconds(null);
        lastEstimateRef.current = now;

        const respiratory = estimateRespiratoryRate(respiratorySamplesRef.current);
        if (respiratory && respiratory.quality >= MIN_RESPIRATION_QUALITY) {
          const current = respiratoryRateRef.current;
          const smoothed = current === null ? respiratory.rate : 0.8 * current + 0.2 * respiratory.rate;
          respiratoryRateRef.current = smoothed;
          setRespiratoryRate(smoothed);
        }

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
      respiratorySamplesRef.current = [];
      candidatesRef.current = [];
      pendingJumpRef.current = [];
      bpmRef.current = null;
      respiratoryRateRef.current = null;
      setBpm(null);
      setRespiratoryRate(null);
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

  // vitalsActive gates the live-check sub-view of the Log Vitals page. It's a
  // separate flag from `monitoring` so the video element (and, if the camera
  // fails, the dev-mode panel) stays mounted through a failed startCamera —
  // only leaveVitalsCheck (Stop / navigating away) returns to the idle view.
  const beginVitalsCheck = () => {
    setVitalsActive(true);
    setTimeout(startCamera, 0);
  };

  const leaveVitalsCheck = () => {
    stopCamera();
    setVitalsActive(false);
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

  const importDoctorPlan = () => {
    try {
      const plan = decodePortable<DoctorMeasurementPlan>(planCode);
      if (plan.version !== 1 || !plan.medicationName?.trim() || !plan.times?.length ||
          !plan.times.every((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time)) ||
          !plan.metrics?.length || plan.metrics.some((metric) => metric !== "heartRate" && metric !== "respiratoryRate")) {
        throw new Error("Invalid measurement plan");
      }
      const match = medications.find((item) => item.name.toLowerCase() === plan.medicationName.toLowerCase());
      const nextMedication: Medication = match ? {
        ...match, checkTimes: plan.times, checks: plan.times.length, measurementMetrics: plan.metrics,
        checkTiming: plan.note || `Measurement plan from ${plan.clinician || "the care team"}.`,
      } : {
        id: crypto.randomUUID(), name: plan.medicationName, dose: "", time: plan.times[0],
        checks: plan.times.length, doseChange: false, checkTimes: plan.times,
        measurementMetrics: plan.metrics,
        checkTiming: plan.note || `Measurement plan from ${plan.clinician || "the care team"}.`,
      };
      const next = match ? medications.map((item) => item.id === match.id ? nextMedication : item) : [...medications, nextMedication];
      setMedications(next);
      localStorage.setItem(MEDICATIONS_KEY, JSON.stringify(next));
      setPlanCode("");
      setPatientNotice(`Imported ${measurementName(plan.metrics).toLowerCase()} reminders for ${plan.medicationName}. This did not create medication-taking reminders.`);
    } catch {
      setPatientNotice("That measurement-plan code could not be read. Ask the doctor to copy the full code again.");
    }
  };

  const openCaregiverView = () => {
    setCaregiverSnapshot({
      version: 1, generatedAt: new Date().toISOString(),
      medications: medications.map(({ name, dose, prescribedDirections, measurementMetrics }) => ({ name, dose, prescribedDirections, measurementMetrics })),
      readings: [...readings].slice(-30), doses: [...doses].slice(-30),
      bloodPressure: [...bloodPressure].slice(-20), symptoms: [...symptoms].slice(-20),
    });
    setScreen("caregiver");
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
      measurementMetrics: ["heartRate"],
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

  const saveReadingAt = (bpmValue: number, date: Date, respiratoryValue: number | null) => {
    const context = readingContext(date);
    const next = [
      ...readings,
      {
        id: crypto.randomUUID(),
        bpm: Math.round(bpmValue * 10) / 10,
        respiratoryRate: respiratoryValue === null ? null : Math.round(respiratoryValue * 10) / 10,
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
    const context = saveReadingAt(bpm, recordedAt, respiratoryRate);
    setStatus(
      offsetMinutes
        ? `Measurement saved · ${context} (offset ${offsetMinutes > 0 ? "+" : ""}${offsetMinutes} min)`
        : `Measurement saved · ${context}`,
    );
  };

  const navigate = (next: Screen) => {
    if (screen === "vitals" && vitalsActive) {
      stopCamera();
      setVitalsActive(false);
    }
    setScreen(next);
  };

  const values = readings.map((reading) => reading.bpm);
  const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const respiratoryValues = readings
    .map((reading) => reading.respiratoryRate)
    .filter((value): value is number => value !== null && value !== undefined);
  const averageRespiratory = respiratoryValues.length
    ? respiratoryValues.reduce((sum, value) => sum + value, 0) / respiratoryValues.length
    : null;

  const recentReadings = [...readings]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, RECENT_READINGS_COUNT);

  const averageOf = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

  const medicationResponses = medications.map((medication) => {
    const medicationDoses = doses.filter((dose) => dose.medicationId === medication.id);
    const offsets = DOSE_RESPONSE_OFFSETS_MINUTES.map((offsetMinutes) => {
      const bpmReductions: number[] = [];
      const respiratoryReductions: number[] = [];
      medicationDoses.forEach((dose) => {
        const doseTime = new Date(dose.timestamp).getTime();
        const baseline = nearestReadingBefore(readings, doseTime, DOSE_BASELINE_WINDOW_MINUTES);
        const followUp = nearestReadingWithin(
          readings,
          doseTime + offsetMinutes * 60_000,
          DOSE_RESPONSE_TOLERANCE_MINUTES,
        );
        if (!baseline || !followUp) return;
        bpmReductions.push(baseline.bpm - followUp.bpm);
        if (baseline.respiratoryRate != null && followUp.respiratoryRate != null) {
          respiratoryReductions.push(baseline.respiratoryRate - followUp.respiratoryRate);
        }
      });
      return {
        offsetMinutes,
        sampleSize: bpmReductions.length,
        averageReduction: bpmReductions.length ? averageOf(bpmReductions) : null,
        respiratorySampleSize: respiratoryReductions.length,
        averageRespiratoryReduction: respiratoryReductions.length ? averageOf(respiratoryReductions) : null,
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
      "CAMERA MEASUREMENTS",
      "Date,Time,BPM,Respiratory rate (breaths/min experimental),Context,Source",
      ...readings.map((reading) => {
        const date = new Date(reading.timestamp);
        return [date.toLocaleDateString(), date.toLocaleTimeString(), reading.bpm, reading.respiratoryRate ?? "",
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
    const graphHeight = 520;
    const renderMetricGraph = (metric: GraphMetric) => {
      const canvas = document.createElement("canvas");
      canvas.width = graphWidth;
      canvas.height = graphHeight;
      const graphContext = canvas.getContext("2d")!;
      graphContext.fillStyle = "#ffffff";
      graphContext.fillRect(0, 0, graphWidth, graphHeight);
      drawPulseGraph(graphContext, graphWidth, graphHeight, recentReadings, doses, metric, 1.8);
      return canvas.toDataURL("image/png");
    };
    const bpmGraphImage = renderMetricGraph(BPM_GRAPH_METRIC);
    const respiratoryGraphImage = renderMetricGraph(RESPIRATION_GRAPH_METRIC);
    const hasRecentBpm = recentReadings.length > 0;
    const hasRecentRespiratory = recentReadings.some((reading) => reading.respiratoryRate != null);

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

    const chartImageHeight = (contentWidth * graphHeight) / graphWidth;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(`Recent heart rate (last ${recentReadings.length} measurements)`, margin, y);
    y += 4;
    if (hasRecentBpm) {
      doc.addImage(bpmGraphImage, "PNG", margin, y, contentWidth, chartImageHeight);
      y += chartImageHeight + 10;
    } else {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(11);
      doc.text("No measurements saved yet.", margin, y + 6);
      y += 14;
    }

    addPageIfNeeded(chartImageHeight + 15);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text("Recent respiratory rate", margin, y);
    y += 4;
    if (hasRecentRespiratory) {
      doc.addImage(respiratoryGraphImage, "PNG", margin, y, contentWidth, chartImageHeight);
      y += chartImageHeight + 10;
    } else {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(11);
      doc.text("No respiratory data in this window.", margin, y + 6);
      y += 14;
    }

    addPageIfNeeded(35);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text("Overview", margin, y);
    y += 7;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text("Heart rate", margin, y);
    y += 6;
    doc.setFont("helvetica", "normal");
    if (readings.length) {
      doc.text(
        `Average: ${average.toFixed(0)} BPM   ·   Range: ${Math.min(...values).toFixed(0)}–` +
          `${Math.max(...values).toFixed(0)} BPM   ·   n=${readings.length}`,
        margin,
        y,
      );
    } else {
      doc.text("No measurements saved yet.", margin, y);
    }
    y += 10;

    doc.setFont("helvetica", "bold");
    doc.text("Respiratory rate", margin, y);
    y += 6;
    doc.setFont("helvetica", "normal");
    if (respiratoryValues.length) {
      doc.text(
        `Average: ${averageRespiratory!.toFixed(0)} breaths/min   ·   Range: ` +
          `${Math.min(...respiratoryValues).toFixed(0)}–${Math.max(...respiratoryValues).toFixed(0)} breaths/min   ·   ` +
          `n=${respiratoryValues.length}`,
        margin,
        y,
      );
    } else {
      doc.text("No respiratory data recorded yet.", margin, y);
    }
    y += 10;

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
        (medication.brand || medication.manufacturer) &&
          `Generic/brand: ${[medication.brand, medication.manufacturer].filter(Boolean).join(" · ")}`,
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
    doc.text(`Blood-pressure readings: ${bloodPressure.length}`, margin, y);
    y += 5;
    doc.text(`Symptoms recorded: ${symptoms.length}`, margin, y);
    y += 8;
    [...bloodPressure].slice(-5).forEach((reading) => {
      addPageIfNeeded(6);
      doc.text(
        `${new Date(reading.timestamp).toLocaleString()} · ${reading.systolic}/${reading.diastolic} mmHg · ${reading.source}`,
        margin + 2,
        y,
      );
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
    doc.text("Change in BPM (and respiratory rate, where recorded) vs. the reading before each dose.", margin, y);
    y += 9;
    doc.setTextColor(20);

    if (!medications.length) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(11);
      doc.text("No medicines added yet.", margin, y);
      y += 8;
    }

    medicationResponses.forEach(({ medication, doseCount, offsets }) => {
      addPageIfNeeded(36);
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
      offsets.forEach(({
        offsetMinutes,
        averageReduction,
        sampleSize,
        averageRespiratoryReduction,
        respiratorySampleSize,
      }, index) => {
        const columnX = margin + index * columnWidth;
        doc.setFont("helvetica", "bold");
        doc.setFontSize(10);
        doc.setTextColor(20);
        doc.text(`${offsetMinutes} min`, columnX, y);

        const change = averageReduction === null ? null : -averageReduction;
        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        doc.setTextColor(25, 118, 74);
        doc.text(
          change === null ? "no data" : `${change > 0 ? "+" : "-"}${Math.abs(change).toFixed(1)} bpm`,
          columnX,
          y + 5,
        );
        doc.setFontSize(7.5);
        doc.setTextColor(110);
        doc.text(change === null ? "" : `n=${sampleSize}`, columnX, y + 9);

        const respiratoryChange = averageRespiratoryReduction === null ? null : -averageRespiratoryReduction;
        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        doc.setTextColor(28, 111, 140);
        doc.text(
          respiratoryChange === null
            ? "no data"
            : `${respiratoryChange > 0 ? "+" : "-"}${Math.abs(respiratoryChange).toFixed(1)} br/min`,
          columnX,
          y + 15,
        );
        doc.setFontSize(7.5);
        doc.setTextColor(110);
        doc.text(respiratoryChange === null ? "" : `n=${respiratorySampleSize}`, columnX, y + 19);
        doc.setTextColor(20);
      });
      y += 25;
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

  const bottomNav = (
    <Paper
      elevation={8}
      sx={{
        position: "fixed",
        zIndex: 10,
        left: "50%",
        bottom: "max(16px, env(safe-area-inset-bottom))",
        transform: "translateX(-50%)",
        width: "min(calc(100% - 32px), 520px)",
        borderRadius: 5,
        overflow: "hidden",
      }}
    >
      <BottomNavigation
        showLabels
        value={screen}
        onChange={(_event, next: Screen) => navigate(next)}
        sx={{ height: 74 }}
      >
        <BottomNavigationAction label="Log Vitals" value="vitals" icon={<MedicalServicesIcon />} />
        <BottomNavigationAction label="Log Medicine" value="medicine" icon={<MedicationIcon />} />
        <BottomNavigationAction label="My Data" value="data" icon={<BarChartIcon />} />
      </BottomNavigation>
    </Paper>
  );

  return (
    <Box className="app-shell" component="main">
      <Dialog open={showKeySetup && keysLoaded} maxWidth="sm" fullWidth aria-label="Set up verification keys">
        <DialogTitle>
          <Typography variant="overline" color="primary" sx={{ display: "block", fontWeight: 800 }}>
            Pulse Window
          </Typography>
          Set up verification keys
        </DialogTitle>
        <DialogContent>
          <Typography color="text.secondary" sx={{ mb: 2 }}>
            Your clinic issued a public and private key for this device. Enter both to continue — they let a
            doctor confirm that an exported summary came from you unaltered. This is optional for daily use.
          </Typography>
          <Stack spacing={2}>
            <TextField
              label="Public key"
              multiline
              minRows={3}
              fullWidth
              value={keySetupPublicInput}
              onChange={(event) => setKeySetupPublicInput(event.target.value)}
              slotProps={{ htmlInput: { style: { fontFamily: "ui-monospace, monospace", fontSize: 13 } } }}
            />
            <TextField
              label="Private key"
              multiline
              minRows={5}
              fullWidth
              value={keySetupPrivateInput}
              onChange={(event) => setKeySetupPrivateInput(event.target.value)}
              slotProps={{ htmlInput: { style: { fontFamily: "ui-monospace, monospace", fontSize: 13 } } }}
            />
            {keySetupError && <Alert severity="error">{keySetupError}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 3, flexDirection: "column", gap: 1 }}>
          <Button variant="contained" size="large" fullWidth onClick={saveKeys} disabled={keySetupSaving}>
            {keySetupSaving ? "Checking…" : "Save and continue"}
          </Button>
          <Button variant="text" fullWidth onClick={() => setShowKeySetup(false)}>Not now</Button>
        </DialogActions>
      </Dialog>
      {screen === "vitals" && !vitalsActive && (
        <Container maxWidth="sm" sx={{ pt: 4, pb: 14 }} component="section">
          <Stack direction="row" spacing={2} sx={{ mb: 3, alignItems: "center" }}>
            <Box
              aria-hidden="true"
              sx={{
                width: 64,
                height: 64,
                display: "grid",
                placeItems: "center",
                borderRadius: 3,
                fontSize: 34,
                color: "common.white",
                bgcolor: "error.main",
                boxShadow: "0 14px 30px rgba(173, 41, 47, .2)",
              }}
            >
              ♥
            </Box>
            <Box>
              <Typography variant="overline" color="primary" sx={{ display: "block", fontWeight: 800 }}>
                Pulse Window
              </Typography>
              <Typography variant="h4" sx={{ fontWeight: 800, letterSpacing: "-0.03em" }}>Log Vitals</Typography>
              <Typography color="text.secondary" suppressHydrationWarning>
                {clock.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}
              </Typography>
            </Box>
          </Stack>

          {patientNotice && <Alert severity="success" sx={{ mb: 2 }}>{patientNotice}</Alert>}

          {nextEvent && (
            <Card sx={{ mb: 2, bgcolor: "#eaf6ef", borderColor: "primary.main" }} variant="outlined">
              <CardContent>
                <Stack direction="row" spacing={2} sx={{ alignItems: "center", justifyContent: "space-between" }}>
                  <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
                    <Typography sx={{ fontSize: 28 }}>♥</Typography>
                    <Box>
                      <Typography variant="overline" color="primary" sx={{ fontWeight: 800, display: "block" }}>
                        {relativePlanTime(nextEvent.date, clock)}
                      </Typography>
                      <Typography variant="h6" sx={{ fontWeight: 800 }}>{nextEvent.label}</Typography>
                      <Typography color="text.secondary" variant="body2">
                        {nextEvent.date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · Based on
                        the plan entered for {nextEvent.medication.name}
                      </Typography>
                    </Box>
                  </Stack>
                </Stack>
                <Button variant="contained" fullWidth sx={{ mt: 2 }} onClick={beginVitalsCheck}>Start measurement</Button>
              </CardContent>
            </Card>
          )}

          <Card sx={{ mb: 3 }}>
            <CardContent>
              <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", justifyContent: "space-between" }}>
                <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
                  <NotificationsIcon color={notificationPermission === "granted" ? "primary" : "action"} />
                  <Box>
                    <Typography sx={{ fontWeight: 800 }}>Measurement reminders</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {notificationPermission === "granted"
                        ? "On for this browser"
                        : notificationPermission === "denied"
                          ? "Blocked in browser settings"
                          : "Not set up yet"}
                    </Typography>
                  </Box>
                </Stack>
                {notificationPermission === "granted"
                  ? <CheckCircleIcon color="success" />
                  : <Button variant="outlined" size="small" onClick={enableNotifications}>Turn on</Button>}
              </Stack>
            </CardContent>
          </Card>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Web reminders work while this page is open. The iPhone app uses system notifications and can remind
            you when closed.
          </Typography>

          <Stack direction="row" spacing={1.5} sx={{ mb: 3 }}>
            <Card sx={{ flex: 1 }}>
              <CardContent>
                <Typography sx={{ color: "error.main", fontSize: 22 }}>♥</Typography>
                <Typography variant="h4" sx={{ fontWeight: 800 }}>
                  {readings.length ? Math.round(readings.at(-1)!.bpm) : "—"}
                </Typography>
                <Typography color="text.secondary" variant="body2">Latest BPM</Typography>
              </CardContent>
            </Card>
            <Card sx={{ flex: 1 }}>
              <CardContent>
                <Typography sx={{ fontSize: 22 }}>🫁</Typography>
                <Typography variant="h4" sx={{ fontWeight: 800 }}>
                  {readings.length && readings.at(-1)!.respiratoryRate != null
                    ? Math.round(readings.at(-1)!.respiratoryRate!)
                    : "—"}
                </Typography>
                <Typography color="text.secondary" variant="body2">Latest breaths/min</Typography>
              </CardContent>
            </Card>
          </Stack>

          <Box sx={{ mb: 2 }}>
            <Typography variant="h6" sx={{ fontWeight: 800 }}>Check your vitals</Typography>
            <Typography color="text.secondary">Uses your camera to estimate pulse and respiratory rate.</Typography>
          </Box>

          <Card sx={{ mb: 3 }}>
            <CardContent>
              <Stack direction="row" spacing={1} sx={{ mb: 1.5, alignItems: "center" }}>
                <PhotoCameraIcon color="primary" />
                <Typography sx={{ fontWeight: 800 }}>Camera check</Typography>
              </Stack>
              {nextMeasurement && (
                <Typography variant="body2" sx={{ mb: 1.5 }}>
                  <b>Next planned check:</b>{" "}
                  {nextMeasurement.date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} for{" "}
                  {nextMeasurement.medication.name}
                </Typography>
              )}
              <Typography color="text.secondary" sx={{ mb: 2 }}>
                Sit still in steady front lighting. Calibration takes 15 seconds, then the app confirms a stable
                estimate.
              </Typography>
              <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
                <FormControl fullWidth size="small">
                  <InputLabel id="camera-label">Camera source</InputLabel>
                  <Select
                    labelId="camera-label"
                    label="Camera source"
                    value={selectedCamera}
                    onChange={(event) => setSelectedCamera(event.target.value)}
                  >
                    {!cameras.length && <MenuItem value="">Default camera</MenuItem>}
                    {cameras.map((camera) => (
                      <MenuItem key={camera.deviceId} value={camera.deviceId}>{camera.label}</MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <Button variant="outlined" onClick={findCameras} sx={{ flexShrink: 0 }}>Identify</Button>
              </Stack>
              <Button variant="contained" size="large" fullWidth onClick={beginVitalsCheck}>Check vitals</Button>
            </CardContent>
          </Card>

          {bottomNav}
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
            Wellness prototype only. Follow medication instructions from your clinician or pharmacist.
          </Typography>
        </Container>
      )}

      {screen === "vitals" && vitalsActive && (
        <section className="monitor-screen">
          <Stack direction="row" className="topbar" sx={{ alignItems: "center", justifyContent: "space-between" }}>
            <Button color="inherit" onClick={leaveVitalsCheck}>← Stop</Button>
            <Typography sx={{ fontWeight: 800 }}>Checking vitals</Typography>
            <Button color="inherit" onClick={() => navigate("data")}>My Data</Button>
          </Stack>

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
            <Stack direction="row" spacing={2.5} sx={{ flexWrap: "wrap" }}>
              <Stack direction="row" spacing={0.75} sx={{ alignItems: "baseline" }}>
                <Typography variant="h3" sx={{ fontWeight: 800, color: "primary.main" }}>
                  {bpm === null ? "--" : Math.round(bpm)}
                </Typography>
                <Typography color="text.secondary" sx={{ fontWeight: 800 }}>BPM</Typography>
              </Stack>
              <Stack direction="row" spacing={0.75} sx={{ alignItems: "baseline" }}>
                <Typography variant="h4" sx={{ fontWeight: 800, color: "secondary.main" }}>
                  {respiratoryRate === null ? "--" : Math.round(respiratoryRate)}
                </Typography>
                <Typography color="text.secondary" sx={{ fontWeight: 800 }}>breaths/min</Typography>
              </Stack>
            </Stack>
            {calibrationSeconds !== null && (
              <Card variant="outlined" sx={{ mt: 2, bgcolor: "#edf8f3", borderColor: "#b9d9cb" }}>
                <CardContent>
                  <Stack direction="row" sx={{ justifyContent: "space-between", alignItems: "baseline", mb: 1 }}>
                    <Typography sx={{ fontWeight: 800, color: "primary.main" }}>Calibrating</Typography>
                    <Typography sx={{ fontWeight: 800 }}>
                      {calibrationSeconds} {calibrationSeconds === 1 ? "second" : "seconds"}
                    </Typography>
                  </Stack>
                  <LinearProgress
                    variant="determinate"
                    value={((INITIAL_CALIBRATION_SECONDS - calibrationSeconds) / INITIAL_CALIBRATION_SECONDS) * 100}
                    sx={{ height: 8, borderRadius: 99 }}
                  />
                </CardContent>
              </Card>
            )}
            <Typography color="text.secondary" sx={{ mt: 1.5 }} aria-live="polite">{status}</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              The breathing estimate needs about 30–40 seconds of still video. It is experimental and must not be
              used to detect respiratory depression or emergencies.
            </Typography>
          </div>

          <Stack direction="row" spacing={1.5} sx={{ width: "min(calc(100% - 32px), 760px)", mx: "auto", mt: 0.5 }}>
            {monitoring ? (
              <Button variant="contained" color="error" fullWidth size="large" onClick={stopCamera}>
                Stop measurement
              </Button>
            ) : (
              <Button variant="contained" fullWidth size="large" onClick={startCamera}>Start again</Button>
            )}
            <Button variant="outlined" fullWidth size="large" onClick={saveReading}>Save measurement</Button>
          </Stack>
          <Button
            onClick={toggleDeveloperMode}
            aria-pressed={developerMode}
            sx={{ display: "block", mx: "auto", mt: 2, color: developerMode ? "primary.main" : "text.secondary" }}
          >
            {developerMode ? "Hide amplified green changes" : "Show amplified green changes"}
          </Button>
          {DEV_MODE && (
            <Card
              variant="outlined"
              sx={{ width: "min(calc(100% - 32px), 420px)", mx: "auto", mt: 1.5, borderStyle: "dashed" }}
            >
              <CardContent>
                <Chip label="Dev mode" size="small" sx={{ mb: 1.5, fontWeight: 800 }} />
                <Stack spacing={2}>
                  <Stack direction="row" spacing={1}>
                    <TextField
                      label="Simulate a BPM reading"
                      type="number"
                      size="small"
                      fullWidth
                      slotProps={{ htmlInput: { min: MIN_BPM, max: MAX_BPM } }}
                      placeholder={`${MIN_BPM}-${MAX_BPM}`}
                      value={simulatedBpmInput}
                      onChange={(event) => setSimulatedBpmInput(event.target.value)}
                    />
                    <Button variant="outlined" onClick={applySimulatedBpm} sx={{ flexShrink: 0 }}>Simulate</Button>
                  </Stack>
                  <TextField
                    label="Respiratory rate (optional)"
                    type="number"
                    size="small"
                    fullWidth
                    slotProps={{ htmlInput: { min: MIN_RESPIRATION_RATE, max: MAX_RESPIRATION_RATE } }}
                    placeholder={`${MIN_RESPIRATION_RATE}-${MAX_RESPIRATION_RATE}`}
                    value={simulatedRespiratoryInput}
                    onChange={(event) => setSimulatedRespiratoryInput(event.target.value)}
                  />
                  <TextField
                    label="Time offset (minutes)"
                    type="number"
                    size="small"
                    fullWidth
                    slotProps={{ htmlInput: { step: 1 } }}
                    value={devTimeOffsetInput}
                    onChange={(event) => setDevTimeOffsetInput(event.target.value)}
                    helperText="Added to the current time when you hit “Save measurement” — e.g. set to 30 to record the next save as 30 minutes from now, without waiting."
                  />
                  <Divider />
                  <Button variant="contained" color="error" size="small" onClick={wipeAllData}>Wipe all data</Button>
                  <Typography variant="caption" color="text.secondary">
                    Clears readings, medicines, and doses from this browser. Your keys are kept.
                  </Typography>
                </Stack>
              </CardContent>
            </Card>
          )}
        </section>
      )}

      {screen === "medicine" && (
        <section className="medications-screen">
          <Stack direction="row" className="topbar" sx={{ alignItems: "center", justifyContent: "space-between" }}>
            <Button color="inherit" onClick={() => navigate("vitals")}>← Log Vitals</Button>
            <Typography sx={{ fontWeight: 800 }}>Log Medicine</Typography>
            <Button color="inherit" onClick={() => navigate("data")}>My Data</Button>
          </Stack>
          <Container maxWidth="sm" sx={{ pt: 4, pb: 14 }}>
            <Typography variant="overline" color="primary" sx={{ display: "block", fontWeight: 800 }}>
              Your care plan
            </Typography>
            <Typography variant="h4" sx={{ fontWeight: 800, letterSpacing: "-0.03em", mb: 1 }}>
              Medicines and vitals checks
            </Typography>
            <Typography color="text.secondary" sx={{ mb: 2 }}>
              Enter only schedules provided by your healthcare professional.
            </Typography>

            {patientNotice && <Alert severity="success" sx={{ mb: 2 }}>{patientNotice}</Alert>}

            <Accordion sx={{ mb: 2 }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                  <AddIcon color="primary" fontSize="small" />
                  <Typography sx={{ fontWeight: 800, color: "primary.main" }}>
                    Import a measurement plan from your doctor
                  </Typography>
                </Stack>
              </AccordionSummary>
              <AccordionDetails>
                <Typography variant="h6" sx={{ mb: 1 }}>Doctor measurement-plan code</Typography>
                <Typography color="text.secondary" sx={{ mb: 2 }}>
                  This only schedules heart-rate or breathing-rate checks. It will never tell you when to take
                  medication.
                </Typography>
                <TextField
                  multiline
                  minRows={5}
                  fullWidth
                  value={planCode}
                  onChange={(event) => setPlanCode(event.target.value)}
                  placeholder="Paste the code supplied by the doctor portal"
                  sx={{ mb: 2 }}
                />
                <Button variant="contained" fullWidth onClick={importDoctorPlan} disabled={!planCode.trim()}>
                  Import measurement reminders
                </Button>
              </AccordionDetails>
            </Accordion>

            {medications.length > 0 && (() => {
              const medication = [...medications].sort((a, b) => a.time.localeCompare(b.time))[0];
              return (
                <Card sx={{ mb: 3 }}>
                  <CardContent>
                    <Stack direction="row" spacing={1} sx={{ mb: 1.5, alignItems: "center" }}>
                      <AlarmIcon color="primary" fontSize="small" />
                      <Typography sx={{ fontWeight: 800 }}>Next medication</Typography>
                    </Stack>
                    <Stack direction="row" sx={{ justifyContent: "space-between", alignItems: "center", mb: 1 }}>
                      <Box>
                        <Typography variant="h6">{medication.name}</Typography>
                        <Typography color="text.secondary">{medication.dose || "Dose not entered"}</Typography>
                      </Box>
                      <Typography variant="h6" color="primary">{medication.time}</Typography>
                    </Stack>
                    <Typography color="text.secondary" sx={{ mb: 1 }}>
                      Log the actual dose time so vitals checks can be shown before and after it.
                    </Typography>
                    {medication.monitoringFrequency && (
                      <Stack direction="row" spacing={1} sx={{ mb: 0.5, alignItems: "center" }}>
                        <RepeatIcon fontSize="small" color="action" />
                        <Typography>{medication.monitoringFrequency}</Typography>
                      </Stack>
                    )}
                    <Stack direction="row" spacing={1} sx={{ mb: 1, alignItems: "center" }}>
                      <NotificationsIcon fontSize="small" color="action" />
                      <Typography>Vitals-check reminders: {reminderTimeSummary(medication)}</Typography>
                    </Stack>
                    {medication.checkTiming && (
                      <Typography color="text.secondary" sx={{ mb: 1.5 }}>
                        <b>Suggested check timing:</b> {medication.checkTiming}
                      </Typography>
                    )}
                    <Button variant="outlined" startIcon={<CheckCircleIcon />} onClick={() => logDose(medication)}>
                      Log {medication.name} as taken
                    </Button>
                  </CardContent>
                </Card>
              );
            })()}

            <Typography variant="h6" sx={{ fontWeight: 800, mb: 1.5 }}>Your medicines</Typography>
            <Stack spacing={1.5} sx={{ mb: 3 }}>
              {medications.length === 0 && (
                <Card sx={{ textAlign: "center", p: 3 }}>
                  <MedicationIcon color="primary" sx={{ fontSize: 34 }} />
                  <Typography variant="h6">No medicines yet</Typography>
                  <Typography color="text.secondary">Use “Add a medicine” below to create your monitoring plan.</Typography>
                </Card>
              )}
              {medications.map((medication) => (
                <Card key={medication.id}>
                  <CardContent>
                    <Stack direction="row" spacing={1.5} sx={{ mb: 1 }}>
                      {medication.photoDataUrl ? (
                        <Box
                          component="img"
                          src={medication.photoDataUrl}
                          alt={`${medication.name} packaging or tablet`}
                          sx={{ width: 56, height: 56, borderRadius: 2, objectFit: "cover", flexShrink: 0 }}
                        />
                      ) : (
                        <Box
                          aria-label="No medicine photo"
                          sx={{
                            width: 56, height: 56, borderRadius: 2, flexShrink: 0,
                            display: "grid", placeItems: "center", bgcolor: "#f2f6f3", fontSize: 26,
                          }}
                        >
                          💊
                        </Box>
                      )}
                      <Stack direction="row" sx={{ flex: 1, justifyContent: "space-between", alignItems: "flex-start" }}>
                        <Box>
                          <Typography variant="h6">{medication.name}</Typography>
                          <Typography color="text.secondary">{medication.dose || "Strength or dose not entered"}</Typography>
                        </Box>
                        <Typography variant="h6" color="primary">{medication.time}</Typography>
                      </Stack>
                    </Stack>
                    {medication.activeIngredient && medication.activeIngredient.toLowerCase() !== medication.name.toLowerCase() && (
                      <Typography sx={{ mb: 0.5 }}><b>Active ingredient:</b> {medication.activeIngredient}</Typography>
                    )}
                    {(medication.brand || medication.manufacturer) && (
                      <Typography sx={{ mb: 0.5 }}>
                        <b>Generic/brand:</b> {[medication.brand, medication.manufacturer].filter(Boolean).join(" · ")}
                      </Typography>
                    )}
                    {medication.prescribedDirections && (
                      <Typography sx={{ mb: 0.5 }}><b>Pharmacy directions:</b> {medication.prescribedDirections}</Typography>
                    )}
                    {medication.purpose && (
                      <Typography sx={{ mb: 0.5 }}><b>Reason:</b> {medication.purpose}</Typography>
                    )}
                    {medication.prescriber && (
                      <Typography sx={{ mb: 0.5 }}><b>Prescriber:</b> {medication.prescriber}</Typography>
                    )}
                    <Stack direction="row" spacing={1} sx={{ mb: 0.5, alignItems: "center" }}>
                      <RepeatIcon fontSize="small" color="action" />
                      <Typography>
                        {medication.checks} planned {measurementName(medication.measurementMetrics).toLowerCase()}
                        {medication.checks === 1 ? "" : "s"} daily
                      </Typography>
                    </Stack>
                    {medication.monitoringFrequency && (
                      <Typography color="text.secondary" sx={{ mb: 0.5 }}>{medication.monitoringFrequency}</Typography>
                    )}
                    <Stack direction="row" spacing={1} sx={{ mb: 0.5, alignItems: "center" }}>
                      <NotificationsIcon fontSize="small" color="action" />
                      <Typography>Reminder times: {reminderTimeSummary(medication)}</Typography>
                    </Stack>
                    {medication.formulation && (
                      <Typography sx={{ mb: 0.5 }}><b>Formulation:</b> {medication.formulation}</Typography>
                    )}
                    {medication.checkTiming && (
                      <Typography color="text.secondary" sx={{ mb: 0.5 }}>
                        <b>Suggested pulse-check timing:</b> {medication.checkTiming}
                      </Typography>
                    )}
                    {medication.doseChange && (
                      <Stack direction="row" spacing={1} sx={{ mb: 1, alignItems: "center", color: "warning.main" }}>
                        <AutorenewIcon fontSize="small" color="warning" />
                        <Typography color="warning.main">Dose-change monitoring enabled</Typography>
                      </Stack>
                    )}
                  </CardContent>
                  <CardActions sx={{ px: 2, pb: 2 }}>
                    <Button variant="outlined" size="small" startIcon={<CheckCircleIcon />} onClick={() => logDose(medication)}>
                      Log dose as taken
                    </Button>
                    <Button
                      variant="text"
                      size="small"
                      color="error"
                      startIcon={<DeleteOutlineIcon />}
                      onClick={() => removeMedication(medication.id)}
                    >
                      Remove medicine
                    </Button>
                  </CardActions>
                </Card>
              ))}
            </Stack>

            <Accordion defaultExpanded={medications.length === 0} sx={{ mb: 2 }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                  <AddIcon color="primary" fontSize="small" />
                  <Typography sx={{ fontWeight: 800, color: "primary.main" }}>Add a medicine</Typography>
                </Stack>
              </AccordionSummary>
              <AccordionDetails>
                <Typography variant="h6" sx={{ mb: 1 }}>Choose a medicine template</Typography>
                <Typography color="text.secondary" sx={{ mb: 2 }}>
                  Select a medicine to fill its monitoring intervals. Confirm the plan with a clinician or pharmacist.
                </Typography>
                <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 1.5, mb: 3 }}>
                  {MEDICATION_PRESETS.map((preset) => (
                    <Card
                      key={preset.id}
                      variant="outlined"
                      sx={{
                        borderColor: selectedPresetId === preset.id ? "primary.main" : "divider",
                        bgcolor: selectedPresetId === preset.id ? "#eaf6ef" : "transparent",
                      }}
                    >
                      <CardActionArea onClick={() => applyMedicationPreset(preset.id)} sx={{ p: 1.75 }}>
                        <Typography sx={{ fontWeight: 800, color: "primary.main" }}>{preset.name}</Typography>
                        <Typography sx={{ fontWeight: 800 }} variant="body2">{preset.monitoringFrequency}</Typography>
                        <Typography variant="body2" color="text.secondary">{preset.formulation}</Typography>
                        <Typography variant="body2" color="text.secondary">{preset.schedule}</Typography>
                      </CardActionArea>
                    </Card>
                  ))}
                </Box>

                <Box component="form" onSubmit={(event) => { event.preventDefault(); void addMedication(); }}>
                  <Typography variant="h6" sx={{ mb: 2 }}>Check the medicine details</Typography>
                  <Stack spacing={2} sx={{ mb: 2 }}>
                    <FormControl fullWidth>
                      <InputLabel id="preset-label">Medicine template</InputLabel>
                      <Select
                        labelId="preset-label"
                        label="Medicine template"
                        value={selectedPresetId}
                        onChange={(event) => applyMedicationPreset(event.target.value)}
                      >
                        <MenuItem value="custom">Custom</MenuItem>
                        {MEDICATION_PRESETS.map((preset) => (
                          <MenuItem key={preset.id} value={preset.id}>{preset.name}</MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    <TextField
                      label="Name shown on the pharmacy label"
                      value={medicineName}
                      onChange={(event) => setMedicineName(event.target.value)}
                      placeholder="e.g. APO-Metoprolol"
                      required
                      fullWidth
                    />
                    <TextField
                      label="Active ingredient"
                      value={medicineActiveIngredient}
                      onChange={(event) => setMedicineActiveIngredient(event.target.value)}
                      placeholder="e.g. metoprolol"
                      fullWidth
                    />
                    <TextField
                      label="Brand or generic prefix"
                      value={medicineBrand}
                      onChange={(event) => setMedicineBrand(event.target.value)}
                      placeholder="e.g. APO, Sandoz"
                      fullWidth
                    />
                    <TextField
                      label="Manufacturer"
                      value={medicineManufacturer}
                      onChange={(event) => setMedicineManufacturer(event.target.value)}
                      placeholder="e.g. Apotex"
                      fullWidth
                    />
                    <TextField
                      label="Strength or dose"
                      value={medicineDose}
                      onChange={(event) => setMedicineDose(event.target.value)}
                      placeholder="e.g. 25 mg"
                      fullWidth
                    />
                    <TextField
                      label="Pharmacy-label directions"
                      value={medicineDirections}
                      onChange={(event) => setMedicineDirections(event.target.value)}
                      placeholder="e.g. Take one tablet each morning"
                      fullWidth
                    />
                    <TextField
                      label="Reason for taking it"
                      value={medicinePurpose}
                      onChange={(event) => setMedicinePurpose(event.target.value)}
                      placeholder="e.g. heart rhythm"
                      fullWidth
                    />
                    <TextField
                      label="Prescriber"
                      value={medicinePrescriber}
                      onChange={(event) => setMedicinePrescriber(event.target.value)}
                      placeholder="e.g. Dr Smith"
                      fullWidth
                    />
                    <TextField
                      label="Start date"
                      type="date"
                      value={medicineStartDate}
                      onChange={(event) => setMedicineStartDate(event.target.value)}
                      fullWidth
                      slotProps={{ inputLabel: { shrink: true } }}
                    />
                    <TextField
                      label="Usual dose time"
                      type="time"
                      value={medicineTime}
                      onChange={(event) => setMedicineTime(event.target.value)}
                      fullWidth
                      slotProps={{ inputLabel: { shrink: true } }}
                    />
                    {selectedPresetId === "custom" ? (
                      <TextField
                        label="Daily measurement time confirmed by clinician"
                        type="time"
                        value={medicineCheckTime}
                        onChange={(event) => { setMedicineCheckTime(event.target.value); setMedicineChecks(1); }}
                        fullWidth
                        slotProps={{ inputLabel: { shrink: true } }}
                      />
                    ) : (
                      <Stack direction="row" sx={{ justifyContent: "space-between" }}>
                        <Typography color="text.secondary">Planned checks</Typography>
                        <Typography sx={{ fontWeight: 800 }}>{medicineChecks} each day</Typography>
                      </Stack>
                    )}
                  </Stack>
                  <Button component="label" variant="outlined" fullWidth sx={{ mb: 1 }}>
                    Photo of the packaging or tablet
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      hidden
                      onChange={(event) => void prepareMedicinePhoto(event.target.files?.[0])}
                    />
                  </Button>
                  {medicinePhoto && (
                    <Stack direction="row" spacing={1.5} sx={{ mb: 1.5, alignItems: "center" }}>
                      <Box
                        component="img"
                        src={medicinePhoto}
                        alt="Preview of the medicine being added"
                        sx={{ width: 64, height: 64, borderRadius: 2, objectFit: "cover" }}
                      />
                      <Button size="small" onClick={() => setMedicinePhoto("")}>Remove photo</Button>
                    </Stack>
                  )}
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    Use the pharmacy label as the source of truth. A photo helps recognition but cannot confirm a
                    medicine’s identity.
                  </Typography>
                  <FormControlLabel
                    sx={{ mb: 1 }}
                    control={
                      <Checkbox
                        checked={doseChange}
                        onChange={(event) => setDoseChangePlan(event.target.checked)}
                      />
                    }
                    label="Extra monitoring during a dose change or loading period"
                  />
                  {selectedPresetId !== "custom" && (() => {
                    const preset = MEDICATION_PRESETS.find((item) => item.id === selectedPresetId);
                    const offsets = doseChange ? preset?.changeOffsets : preset?.routineOffsets;
                    return preset && offsets ? (
                      <Alert severity="info" sx={{ mb: 2 }}>
                        <Typography sx={{ fontWeight: 800 }}>{preset.monitoringFrequency}</Typography>
                        <Typography variant="body2">{preset.formulation}</Typography>
                        <Typography variant="body2" sx={{ mb: 0.5 }}>{preset.schedule}</Typography>
                        <Typography variant="body2" sx={{ fontWeight: 800 }}>
                          Reminder times: {reminderTimesFor(medicineTime, offsets)}
                        </Typography>
                      </Alert>
                    ) : null;
                  })()}
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    These are pulse-check reminders, not instructions for taking medicine. Turn on extra monitoring
                    only when your clinician requested it.
                  </Typography>
                  <Button variant="contained" size="large" fullWidth type="submit">
                    Save medicine and enable reminders
                  </Button>
                </Box>
              </AccordionDetails>
            </Accordion>
            <Typography variant="body2" color="text.secondary">
              Reminders support an existing care plan; they do not recommend when or how often to take medication.
            </Typography>
          </Container>
          {bottomNav}
        </section>
      )}

      {screen === "data" && (
        <section className="history-screen">
          <Stack direction="row" className="topbar" sx={{ alignItems: "center", justifyContent: "space-between" }}>
            <Button color="inherit" onClick={() => navigate("vitals")}>← Log Vitals</Button>
            <Typography sx={{ fontWeight: 800 }}>My Data</Typography>
            <Button color="inherit" onClick={() => navigate("medicine")}>Log Medicine</Button>
          </Stack>
          <Container maxWidth="sm" sx={{ pt: 4, pb: 14 }}>
            <Typography variant="h4" sx={{ fontWeight: 800, letterSpacing: "-0.03em", mb: 1 }}>
              Vitals and medication timeline
            </Typography>
            <Typography color="text.secondary" sx={{ mb: 2 }}>
              Dose markers show when each vitals check was recorded. Data stays in this browser.
            </Typography>
            {!!readings.length && (
              <Stack direction="row" spacing={3} sx={{ flexWrap: "wrap", mb: 1.5, color: "text.secondary" }}>
                <Typography><b>{readings.length}</b> measurements</Typography>
                <Typography><b>{average.toFixed(0)}</b> average BPM</Typography>
                <Typography>
                  <b>{Math.min(...values).toFixed(0)}–{Math.max(...values).toFixed(0)}</b> BPM range
                </Typography>
              </Stack>
            )}
            {!!respiratoryValues.length && (
              <Stack direction="row" spacing={3} sx={{ flexWrap: "wrap", mb: 2, color: "text.secondary" }}>
                <Typography><b>{respiratoryValues.length}</b> respiratory measurements</Typography>
                <Typography><b>{averageRespiratory!.toFixed(0)}</b> average breaths/min</Typography>
                <Typography>
                  <b>{Math.min(...respiratoryValues).toFixed(0)}–{Math.max(...respiratoryValues).toFixed(0)}</b> breaths/min range
                </Typography>
              </Stack>
            )}
            <Stack direction="row" sx={{ justifyContent: "space-between", alignItems: "baseline", mt: 3, mb: 1 }}>
              <Typography variant="h6" sx={{ fontWeight: 800 }}>Heart rate</Typography>
              <Typography variant="body2" color="text.secondary">Pulse rate (BPM)</Typography>
            </Stack>
            <HistoryGraph
              readings={readings}
              doses={doses}
              metric={BPM_GRAPH_METRIC}
              emptyMessage="No saved measurements yet"
              ariaLabel="Saved pulse measurements plotted over time"
            />
            <Stack direction="row" sx={{ justifyContent: "space-between", alignItems: "baseline", mt: 3, mb: 1 }}>
              <Typography variant="h6" sx={{ fontWeight: 800 }}>Respiratory rate</Typography>
              <Typography variant="body2" color="text.secondary">Breaths per minute</Typography>
            </Stack>
            <HistoryGraph
              readings={readings}
              doses={doses}
              metric={RESPIRATION_GRAPH_METRIC}
              emptyMessage="No respiratory data recorded yet"
              ariaLabel="Saved respiratory rate measurements plotted over time"
            />
            <Typography variant="h6" sx={{ fontWeight: 800, mt: 3, mb: 1.5 }}>Add observations</Typography>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ mb: 3 }}>
              <Card sx={{ flex: 1 }}>
                <CardContent>
                  <Typography variant="h6" sx={{ mb: 0.5 }}>Add blood pressure</Typography>
                  <Typography color="text.secondary" variant="body2" sx={{ mb: 1.5 }}>
                    Enter a reading from a validated upper-arm cuff.
                  </Typography>
                  <Stack direction="row" spacing={1} sx={{ mb: 1.5 }}>
                    <TextField
                      label="Systolic"
                      type="number"
                      value={bpSystolic}
                      onChange={(event) => setBpSystolic(event.target.value)}
                      placeholder="120"
                      fullWidth
                      slotProps={{ htmlInput: { inputMode: "numeric" } }}
                    />
                    <TextField
                      label="Diastolic"
                      type="number"
                      value={bpDiastolic}
                      onChange={(event) => setBpDiastolic(event.target.value)}
                      placeholder="80"
                      fullWidth
                      slotProps={{ htmlInput: { inputMode: "numeric" } }}
                    />
                  </Stack>
                  <Button variant="outlined" fullWidth onClick={addBloodPressure}>Save cuff reading</Button>
                </CardContent>
              </Card>
              <Card sx={{ flex: 1 }}>
                <CardContent>
                  <Typography variant="h6" sx={{ mb: 0.5 }}>Add a symptom</Typography>
                  <Typography color="text.secondary" variant="body2" sx={{ mb: 1.5 }}>
                    Record what you noticed; this does not diagnose the cause.
                  </Typography>
                  <Stack spacing={1.5} sx={{ mb: 1.5 }}>
                    <TextField
                      label="Symptom"
                      value={symptomName}
                      onChange={(event) => setSymptomName(event.target.value)}
                      placeholder="e.g. dizziness"
                      fullWidth
                    />
                    <FormControl fullWidth>
                      <InputLabel id="symptom-severity-label">How noticeable</InputLabel>
                      <Select
                        labelId="symptom-severity-label"
                        label="How noticeable"
                        value={symptomSeverity}
                        onChange={(event) => setSymptomSeverity(event.target.value as SymptomEntry["severity"])}
                      >
                        <MenuItem value="Mild">Mild</MenuItem>
                        <MenuItem value="Moderate">Moderate</MenuItem>
                        <MenuItem value="Severe">Severe</MenuItem>
                      </Select>
                    </FormControl>
                    <TextField
                      label="Optional note"
                      value={symptomNote}
                      onChange={(event) => setSymptomNote(event.target.value)}
                      placeholder="What were you doing?"
                      fullWidth
                    />
                  </Stack>
                  <Button variant="outlined" fullWidth onClick={addSymptom}>Add to timeline</Button>
                </CardContent>
              </Card>
            </Stack>

            <Stack direction="row" sx={{ justifyContent: "space-between", alignItems: "baseline", mb: 1 }}>
              <Typography variant="h6" sx={{ fontWeight: 800 }}>Medication timeline</Typography>
              <Typography variant="body2" color="text.secondary">Newest first</Typography>
            </Stack>
            {(() => {
              const timelineItems = [
                ...readings.map((item) => ({
                  id: item.id, timestamp: item.timestamp, icon: "♥",
                  title: `${item.bpm.toFixed(0)} BPM`,
                  detail: `${item.context || "Routine check"} · PulseWindow camera estimate`,
                })),
                ...doses.map((item) => ({
                  id: item.id, timestamp: item.timestamp, icon: "💊",
                  title: `${item.medicationName} taken`, detail: "Dose logged by patient",
                })),
                ...bloodPressure.map((item) => ({
                  id: item.id, timestamp: item.timestamp, icon: "🩺",
                  title: `${item.systolic}/${item.diastolic} mmHg`, detail: item.source,
                })),
                ...symptoms.map((item) => ({
                  id: item.id, timestamp: item.timestamp, icon: "⚠",
                  title: `${item.severity} ${item.symptom}`, detail: item.note || "Symptom recorded by patient",
                })),
              ]
                .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
                .slice(0, 30);
              if (!timelineItems.length) {
                return (
                  <Card sx={{ textAlign: "center", p: 3, mb: 3 }}>
                    <Typography color="text.secondary">No timeline entries yet.</Typography>
                  </Card>
                );
              }
              return (
                <Card sx={{ mb: 3 }}>
                  <Stack divider={<Divider />}>
                    {timelineItems.map((item) => (
                      <Stack key={`${item.icon}-${item.id}`} direction="row" spacing={1.5} sx={{ px: 2.5, py: 1.75, alignItems: "flex-start" }}>
                        <Typography aria-hidden="true" sx={{ fontSize: 20 }}>{item.icon}</Typography>
                        <Box sx={{ flex: 1 }}>
                          <Typography sx={{ fontWeight: 800 }}>{item.title}</Typography>
                          <Typography variant="body2" color="text.secondary">{item.detail}</Typography>
                          <Typography variant="caption" color="text.secondary">
                            {new Date(item.timestamp).toLocaleString()}
                          </Typography>
                        </Box>
                      </Stack>
                    ))}
                  </Stack>
                </Card>
              );
            })()}

            <Stack direction="row" spacing={1.5} sx={{ mt: 2 }}>
              <Button variant="outlined" fullWidth size="large" onClick={exportSignedReport}>
                Export report
              </Button>
              <Button variant="outlined" fullWidth size="large" onClick={openCaregiverView}>
                Open caregiver view
              </Button>
            </Stack>
            <Typography variant="h6" sx={{ fontWeight: 800, mt: 3, mb: 1 }}>Every measurement</Typography>
            {!!readings.length && (
            <Card>
              <Stack divider={<Divider />}>
                {[...readings]
                  .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
                  .map((reading) => (
                  <Stack
                    key={reading.id}
                    direction="row"
                    sx={{ justifyContent: "space-between", alignItems: "center", px: 2.5, py: 2 }}
                  >
                    <Box>
                      <Typography variant="body2" color="text.secondary">
                        {new Date(reading.timestamp).toLocaleDateString(undefined, {
                          weekday: "short",
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                      </Typography>
                      <Typography sx={{ fontWeight: 750 }}>
                        {new Date(reading.timestamp).toLocaleTimeString(undefined, {
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </Typography>
                      <Typography variant="caption" color="#8a5a25">{reading.context || "Routine check"}</Typography>
                    </Box>
                    <Stack direction="row" spacing={1.75} sx={{ alignItems: "baseline" }}>
                      <Typography sx={{ fontWeight: 800, color: "primary.main" }}>
                        {reading.bpm.toFixed(0)} <Typography component="span" variant="caption">BPM</Typography>
                      </Typography>
                      {reading.respiratoryRate != null && (
                        <Typography sx={{ fontWeight: 800, color: "secondary.main", fontSize: 16 }}>
                          {reading.respiratoryRate.toFixed(0)}{" "}
                          <Typography component="span" variant="caption">br/min</Typography>
                        </Typography>
                      )}
                    </Stack>
                  </Stack>
                ))}
              </Stack>
            </Card>
            )}
            <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
              Review estimates with a qualified healthcare professional. Do not change medication based on this app
              alone.
            </Typography>
          </Container>
          {bottomNav}
        </section>
      )}

      {screen === "caregiver" && caregiverSnapshot && (
        <section className="history-screen">
          <Stack direction="row" className="topbar" sx={{ alignItems: "center", justifyContent: "space-between" }}>
            <Button color="inherit" onClick={() => setScreen("data")}>← Exit caregiver view</Button>
            <Typography sx={{ fontWeight: 800 }}>Caregiver view</Typography>
            <Box sx={{ width: 96 }} />
          </Stack>
          <Container maxWidth="sm" sx={{ pt: 4, pb: 6 }}>
            <Typography variant="overline" color="primary" sx={{ display: "block", fontWeight: 800 }}>
              Read only
            </Typography>
            <Typography variant="h4" sx={{ fontWeight: 800, letterSpacing: "-0.03em", mb: 1 }}>
              Care summary
            </Typography>
            <Typography color="text.secondary" sx={{ mb: 2 }}>
              Snapshot created {new Date(caregiverSnapshot.generatedAt).toLocaleString()}. Nothing can be edited
              from this screen.
            </Typography>
            <Stack direction="row" spacing={3} sx={{ flexWrap: "wrap", mb: 3, color: "text.secondary" }}>
              <Typography><b>{caregiverSnapshot.readings.length}</b> measurements</Typography>
              <Typography><b>{caregiverSnapshot.medications.length}</b> medicines</Typography>
              <Typography><b>{caregiverSnapshot.symptoms.length}</b> symptoms</Typography>
            </Stack>
            <Stack spacing={1.5} sx={{ mb: 3 }}>
              {caregiverSnapshot.medications.map((medication, index) => (
                <Card key={`${medication.name}-${index}`}>
                  <CardContent>
                    <Typography variant="h6">{medication.name}</Typography>
                    <Typography color="text.secondary">{medication.dose || "Dose not recorded"}</Typography>
                    {medication.prescribedDirections && <Typography>{medication.prescribedDirections}</Typography>}
                    <Typography variant="body2" color="text.secondary">
                      {measurementName(medication.measurementMetrics)}
                    </Typography>
                  </CardContent>
                </Card>
              ))}
            </Stack>
            <Stack direction="row" sx={{ justifyContent: "space-between", alignItems: "baseline", mb: 1 }}>
              <Typography variant="h6" sx={{ fontWeight: 800 }}>Recent measurements</Typography>
              <Typography variant="body2" color="text.secondary">Newest first</Typography>
            </Stack>
            <Card sx={{ mb: 3 }}>
              <Stack divider={<Divider />}>
                {[...caregiverSnapshot.readings].reverse().map((reading) => (
                  <Stack key={reading.id} direction="row" spacing={1.5} sx={{ px: 2.5, py: 1.75, alignItems: "flex-start" }}>
                    <Typography aria-hidden="true" sx={{ fontSize: 20 }}>♥</Typography>
                    <Box>
                      <Typography sx={{ fontWeight: 800 }}>
                        {reading.bpm.toFixed(0)} BPM
                        {reading.respiratoryRate ? ` · ${reading.respiratoryRate.toFixed(0)} breaths/min (experimental)` : ""}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">{reading.context || "Routine check"}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {new Date(reading.timestamp).toLocaleString()}
                      </Typography>
                    </Box>
                  </Stack>
                ))}
              </Stack>
            </Card>
            <Typography variant="body2" color="text.secondary">
              Caregiver view is informational only. Breathing rate is experimental. Follow the care plan and seek
              urgent help for concerning symptoms.
            </Typography>
          </Container>
        </section>
      )}
    </Box>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";

type Screen = "start" | "monitor" | "medications" | "history";
type Camera = { deviceId: string; label: string };
type Reading = { id: string; bpm: number; timestamp: string; context?: string };
type Medication = {
  id: string;
  name: string;
  dose: string;
  time: string;
  checks: number;
  doseChange: boolean;
  monitoringFrequency?: string;
  formulation?: string;
  checkTiming?: string;
  checkOffsetMinutes?: number[];
};
type DoseEvent = { id: string; medicationId: string; medicationName: string; timestamp: string };
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

function HistoryGraph({ readings, doses }: { readings: Reading[]; doses: DoseEvent[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !readings.length) return;
    const ordered = [...readings].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    const draw = () => {
      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      const context = canvas.getContext("2d")!;
      context.scale(ratio, ratio);
      context.clearRect(0, 0, width, height);

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
  const [faceBox, setFaceBox] = useState<FaceBox | null>(null);
  const [readings, setReadings] = useState<Reading[]>([]);
  const [medications, setMedications] = useState<Medication[]>([]);
  const [doses, setDoses] = useState<DoseEvent[]>([]);
  const [medicineName, setMedicineName] = useState("");
  const [medicineDose, setMedicineDose] = useState("");
  const [medicineTime, setMedicineTime] = useState("09:00");
  const [medicineChecks, setMedicineChecks] = useState(2);
  const [doseChange, setDoseChange] = useState(false);
  const [selectedPresetId, setSelectedPresetId] = useState("custom");
  const [patientNotice, setPatientNotice] = useState("");
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
    }, 0);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (Notification.permission !== "granted") return;
      const now = new Date();
      const currentMinutes = now.getHours() * 60 + now.getMinutes();
      medications.forEach((medication) => {
        const [hour, minute] = medication.time.split(":").map(Number);
        const doseMinutes = hour * 60 + minute;
        const reminders = [
          { offset: 0, title: "Medication check-in", body: `If you took ${medication.name}, log the dose in PulseWindow.` },
          ...medicationCheckOffsets(medication).map((offset) => ({
            offset,
            title: "Pulse check",
            body: `${reminderTiming(offset)} for ${medication.name}. Use the plan confirmed by your clinician.`,
          })),
        ];
        reminders.forEach((reminder, index) => {
          const target = (doseMinutes + reminder.offset + 1440) % 1440;
          if (target !== currentMinutes) return;
          const key = `pulse-window-notified-${medication.id}-${index}-${now.toDateString()}`;
          if (sessionStorage.getItem(key)) return;
          new Notification(reminder.title, { body: reminder.body });
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
    } catch {
      setStatus("Allow camera access to show camera names");
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
    } catch {
      stopCamera();
      setStatus("Face tracker could not start — check your connection and camera permission");
    }
  }, [analyseFrame, cameras, findCameras, loadFaceDetector, selectedCamera, stopCamera]);

  const openMonitor = async () => {
    setScreen("monitor");
    setTimeout(startCamera, 0);
  };

  const applyMedicationPreset = (id: string) => {
    setSelectedPresetId(id);
    const preset = MEDICATION_PRESETS.find((item) => item.id === id);
    if (!preset) return;
    setMedicineName(preset.name);
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
      dose: medicineDose.trim(),
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
    };
    const next = [...medications, medication];
    setMedications(next);
    localStorage.setItem(MEDICATIONS_KEY, JSON.stringify(next));
    setMedicineName(""); setMedicineDose(""); setDoseChange(false);
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

  const saveReading = () => {
    if (bpm === null) {
      setStatus("Wait for a confirmed measurement before saving");
      return;
    }
    const context = readingContext(new Date());
    const next = [
      ...readings,
      {
        id: crypto.randomUUID(),
        bpm: Math.round(bpm * 10) / 10,
        timestamp: new Date().toISOString(),
        context,
      },
    ];
    setReadings(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setStatus(`Measurement saved · ${context}`);
  };

  const navigate = (next: Screen) => {
    if (screen === "monitor") stopCamera();
    setScreen(next);
  };

  const values = readings.map((reading) => reading.bpm);
  const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

  const exportSummary = () => {
    const rows = [
      "PulseWindow monitoring summary",
      "Wellness estimates only - not a diagnosis or medical record",
      "",
      "PULSE MEASUREMENTS",
      "Date,Time,BPM,Context",
      ...readings.map((reading) => {
        const date = new Date(reading.timestamp);
        return `${date.toLocaleDateString()},${date.toLocaleTimeString()},${reading.bpm},${reading.context || "Routine check"}`;
      }),
      "",
      "DOSES TAKEN",
      "Date,Time,Medication",
      ...doses.map((dose) => {
        const date = new Date(dose.timestamp);
        return `${date.toLocaleDateString()},${date.toLocaleTimeString()},${dose.medicationName}`;
      }),
    ];
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/csv" }));
    link.download = "pulsewindow-summary.csv";
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <main className="app-shell">
      {screen === "start" && (
        <section className="dashboard-screen">
          <header className="dashboard-header">
            <div className="brand-mark" aria-hidden="true">♥</div>
            <div><p className="eyebrow">Pulse Window</p><h1>Today</h1></div>
          </header>

          <div className="metric-grid">
            <article className="metric-card"><span>♥</span><strong>{readings.length ? Math.round(readings.at(-1)!.bpm) : "—"}</strong><small>Latest BPM</small></article>
            <article className="metric-card"><span>💊</span><strong>{medications.length}</strong><small>Medicines</small></article>
          </div>

          <div className="task-heading">
            <h2>What would you like to do?</h2>
            <p>Choose one of the large actions below.</p>
          </div>

          {patientNotice && <div className="patient-notice" role="status">✓ {patientNotice}</div>}

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
                  <div className="medicine-card-head"><div><h3>{medication.name}</h3><p>{medication.dose || "Dose not entered"}</p></div><strong>{medication.time}</strong></div>
                  <p>⌁ {medication.checks} planned pulse check{medication.checks === 1 ? "" : "s"} daily</p>
                  {medication.monitoringFrequency && <p className="monitoring-frequency">{medication.monitoringFrequency}</p>}
                  <p className="reminder-times">◷ Reminder times: {reminderTimeSummary(medication)}</p>
                  {medication.formulation && <p><b>Formulation:</b> {medication.formulation}</p>}
                  {medication.checkTiming && <p className="check-timing"><b>Suggested pulse-check timing:</b> {medication.checkTiming}</p>}
                  {medication.doseChange && <p className="dose-change">↻ Dose-change monitoring enabled</p>}
                  <div className="card-actions"><button className="secondary" onClick={() => logDose(medication)}>✓ Log dose as taken</button><button className="delete-button" onClick={() => removeMedication(medication.id)}>Remove medicine</button></div>
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
                    <label>Medicine name<input value={medicineName} onChange={(event) => setMedicineName(event.target.value)} placeholder="e.g. prescribed medicine" required /></label>
                    <label>Dose (optional)<input value={medicineDose} onChange={(event) => setMedicineDose(event.target.value)} placeholder="e.g. 5 mg" /></label>
                    <label>Usual dose time<input type="time" value={medicineTime} onChange={(event) => setMedicineTime(event.target.value)} /></label>
                    {selectedPresetId === "custom" ? <label>Pulse checks each day<select value={medicineChecks} onChange={(event) => setMedicineChecks(Number(event.target.value))}>
                      <option value="1">Once</option><option value="2">Twice</option><option value="3">3 times</option><option value="4">4 times</option>
                    </select></label> : <div className="form-plan-summary"><span>Planned checks</span><b>{medicineChecks} each day</b></div>}
                  </div>
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
            <p>Dose markers show when each pulse estimate was recorded. Data stays in this browser.</p>
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
            <button className="secondary export-button" onClick={exportSummary}>Export clinician summary</button>
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

"use client";

import { useEffect, useRef, useState } from "react";
import {
  concatArrayBuffers,
  exportPrivateKeyBase64,
  exportPublicKeyBase64,
  generateSigningKeyPair,
  importPublicKeyBase64,
  verifyReportSignature,
} from "./crypto";
import { parseCsv, recordsToCsv, type PatientRecord } from "./csv";

const REGISTRY_STORAGE_KEY = "pulsewindow-doctor-portal-registry";

type IssuedKeys = { patientId: string; publicKey: string; privateKey: string };
type VerifyResult = {
  status: "valid" | "invalid" | "unknown" | "error";
  message: string;
  record?: PatientRecord;
};
type MeasurementMetric = "heartRate" | "respiratoryRate";

function encodePortable(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function generatePatientId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join("").slice(0, 8).toUpperCase();
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API may be unavailable (e.g. insecure context) — the field
    // is still selectable and copyable by hand.
  }
}

export default function Home() {
  const [registry, setRegistry] = useState<PatientRecord[]>([]);
  const [name, setName] = useState("");
  const [dob, setDob] = useState("");
  const [issuing, setIssuing] = useState(false);
  const [issuedKeys, setIssuedKeys] = useState<IssuedKeys | null>(null);
  const [planMedication, setPlanMedication] = useState("");
  const [planTimes, setPlanTimes] = useState("09:00");
  const [planHeartRate, setPlanHeartRate] = useState(true);
  const [planRespiratoryRate, setPlanRespiratoryRate] = useState(false);
  const [planNote, setPlanNote] = useState("");
  const [measurementPlanCode, setMeasurementPlanCode] = useState("");

  const [verifyStatus, setVerifyStatus] = useState<"idle" | "checking">("idle");
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);

  const folderInputRef = useRef<HTMLInputElement>(null);
  const registryFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const stored = localStorage.getItem(REGISTRY_STORAGE_KEY);
    if (stored) setRegistry(parseCsv(stored));
  }, []);

  useEffect(() => {
    // webkitdirectory/directory aren't in every React DOM typing, so set
    // them directly on the element rather than fighting JSX prop types.
    const input = folderInputRef.current;
    if (input) {
      input.setAttribute("webkitdirectory", "");
      input.setAttribute("directory", "");
    }
  }, []);

  const saveRegistry = (next: PatientRecord[]) => {
    setRegistry(next);
    localStorage.setItem(REGISTRY_STORAGE_KEY, recordsToCsv(next));
  };

  const createMeasurementPlan = () => {
    const times = planTimes.split(",").map((time) => time.trim()).filter(Boolean);
    const metrics: MeasurementMetric[] = [
      ...(planHeartRate ? ["heartRate" as const] : []),
      ...(planRespiratoryRate ? ["respiratoryRate" as const] : []),
    ];
    if (!planMedication.trim() || !metrics.length || !times.length || !times.every((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time))) return;
    setMeasurementPlanCode(encodePortable({
      version: 1, planId: crypto.randomUUID(), medicationName: planMedication.trim(), metrics, times,
      note: planNote.trim() || undefined, createdAt: new Date().toISOString(),
    }));
  };

  const issueCertification = async () => {
    if (!name.trim() || !dob) return;
    setIssuing(true);
    setIssuedKeys(null);
    try {
      const keyPair = await generateSigningKeyPair();
      const [publicKey, privateKey] = await Promise.all([
        exportPublicKeyBase64(keyPair.publicKey),
        exportPrivateKeyBase64(keyPair.privateKey),
      ]);

      let patientId = generatePatientId();
      while (registry.some((record) => record.patientId === patientId)) {
        patientId = generatePatientId();
      }

      saveRegistry([...registry, { name: name.trim(), dob, patientId, publicKey }]);
      setIssuedKeys({ patientId, publicKey, privateKey });
      setName("");
      setDob("");
    } finally {
      setIssuing(false);
    }
  };

  const downloadRegistry = () => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([recordsToCsv(registry)], { type: "text/csv" }));
    link.download = "pulsewindow-patient-registry.csv";
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const handleRegistryUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    saveRegistry(parseCsv(await file.text()));
  };

  const handleFolderSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    setVerifyResult(null);
    if (!files.length) return;

    const findFile = (targetName: string) => files.find((file) => file.name.toLowerCase() === targetName);
    const reportFile = findFile("analyticalreport.pdf");
    const csvFile = findFile("raw data.csv");
    const hashFile = findFile("hash.txt");
    const publicKeyFile = findFile("public.txt");
    if (!reportFile || !csvFile || !hashFile || !publicKeyFile) {
      setVerifyResult({
        status: "error",
        message:
          "The selected folder must contain AnalyticalReport.pdf, Raw data.csv, and a DigitalSignature " +
          "folder with hash.txt and public.txt.",
      });
      return;
    }

    setVerifyStatus("checking");
    try {
      const [reportBytes, csvBytes, hashText, publicKeyText] = await Promise.all([
        reportFile.arrayBuffer(),
        csvFile.arrayBuffer(),
        hashFile.text(),
        publicKeyFile.text(),
      ]);
      const publicKeyBase64 = publicKeyText.trim();
      const registryMatch = registry.find((record) => record.publicKey === publicKeyBase64);
      if (!registryMatch) {
        setVerifyResult({ status: "unknown", message: "This public key is not in the registry." });
        return;
      }

      const publicKey = await importPublicKeyBase64(publicKeyBase64);
      const signedBytes = concatArrayBuffers(reportBytes, csvBytes);
      const isValid = await verifyReportSignature(publicKey, hashText.trim(), signedBytes);
      setVerifyResult({
        status: isValid ? "valid" : "invalid",
        message: isValid
          ? `Verified — matches ${registryMatch.name} (${registryMatch.patientId}).`
          : `The signature does not match this report, even though the key belongs to ` +
            `${registryMatch.name} (${registryMatch.patientId}). The report may have been altered.`,
        record: registryMatch,
      });
    } catch (error) {
      console.error("Verification failed", error);
      setVerifyResult({ status: "error", message: "Could not read or verify the uploaded files." });
    } finally {
      setVerifyStatus("idle");
    }
  };

  return (
    <main className="portal-page">
      <div className="portal-content">
        <header className="portal-header">
          <p className="eyebrow">PulseWindow</p>
          <h1>Doctor portal</h1>
          <p className="intro">
            Issue signed keys to patients and verify that an exported pulse summary hasn&apos;t been altered
            since it left their device.
          </p>
        </header>

        <section className="portal-card">
          <h2>Issue certification</h2>
          <p className="helper">
            Generates a new key pair for a patient. The private key is shown once and is not stored by this
            portal — hand it to the patient securely so they can enter it into their PulseWindow app.
          </p>
          <div className="field">
            <label htmlFor="patient-name">Name</label>
            <input id="patient-name" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="patient-dob">Date of birth</label>
            <input id="patient-dob" type="date" value={dob} onChange={(event) => setDob(event.target.value)} />
          </div>
          <button className="primary" onClick={issueCertification} disabled={issuing || !name.trim() || !dob}>
            {issuing ? "Generating…" : "Issue certification"}
          </button>

          {issuedKeys && (
            <div className="issued-keys">
              <p className="helper">
                Patient ID <strong>{issuedKeys.patientId}</strong> — saved to the registry below.
              </p>
              <div className="field">
                <label htmlFor="issued-public">Public key</label>
                <textarea id="issued-public" readOnly rows={3} value={issuedKeys.publicKey} />
                <button className="secondary compact" onClick={() => copyToClipboard(issuedKeys.publicKey)}>
                  Copy public key
                </button>
              </div>
              <div className="field">
                <label htmlFor="issued-private">Private key</label>
                <textarea id="issued-private" readOnly rows={5} value={issuedKeys.privateKey} />
                <button className="secondary compact" onClick={() => copyToClipboard(issuedKeys.privateKey)}>
                  Copy private key
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="portal-card">
          <h2>Create a measurement plan</h2>
          <p className="helper">Choose when the patient should measure heart rate, experimental breathing rate, or both. This never schedules medication-taking reminders.</p>
          <div className="field"><label htmlFor="plan-medication">Medication this monitoring relates to</label><input id="plan-medication" value={planMedication} onChange={(event) => setPlanMedication(event.target.value)} placeholder="e.g. alprazolam" /></div>
          <div className="field"><label htmlFor="plan-times">Daily measurement times</label><input id="plan-times" value={planTimes} onChange={(event) => setPlanTimes(event.target.value)} placeholder="09:00, 17:00" /><p className="helper">Use 24-hour times separated by commas.</p></div>
          <div className="field"><label><input type="checkbox" checked={planHeartRate} onChange={(event) => setPlanHeartRate(event.target.checked)} /> Heart rate</label><label><input type="checkbox" checked={planRespiratoryRate} onChange={(event) => setPlanRespiratoryRate(event.target.checked)} /> Breathing rate (experimental)</label></div>
          <div className="field"><label htmlFor="plan-note">Patient-facing note (optional)</label><textarea id="plan-note" rows={3} value={planNote} onChange={(event) => setPlanNote(event.target.value)} placeholder="Why these measurements are useful" /></div>
          <button className="primary" onClick={createMeasurementPlan} disabled={!planMedication.trim() || (!planHeartRate && !planRespiratoryRate)}>Create patient code</button>
          {measurementPlanCode && <div className="issued-keys"><div className="field"><label htmlFor="measurement-plan-code">Measurement-plan code</label><textarea id="measurement-plan-code" readOnly rows={6} value={measurementPlanCode} /></div><p className="helper">Give this code to the patient using your normal approved communication method. It contains only the medication name, measurement types, times and note—no patient identity or clinical record.</p></div>}
        </section>

        <section className="portal-card">
          <h2>Registered patients ({registry.length})</h2>
          <p className="helper">Kept in this browser and can be exported to move it between machines.</p>
          <div className="button-row">
            <button className="secondary compact" onClick={downloadRegistry} disabled={!registry.length}>
              Download registry (.csv)
            </button>
            <button className="secondary compact" onClick={() => registryFileInputRef.current?.click()}>
              Load registry (.csv)
            </button>
            <input
              ref={registryFileInputRef}
              type="file"
              accept=".csv,text/csv"
              hidden
              onChange={handleRegistryUpload}
            />
          </div>
          {registry.length ? (
            <div className="registry-table-wrap">
              <table className="registry-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>DOB</th>
                    <th>Patient ID</th>
                  </tr>
                </thead>
                <tbody>
                  {registry.map((record) => (
                    <tr key={record.patientId}>
                      <td>{record.name}</td>
                      <td>{record.dob}</td>
                      <td>{record.patientId}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="helper">No patients issued yet.</p>
          )}
        </section>

        <section className="portal-card">
          <h2>Verify a report</h2>
          <p className="helper">
            Select the PulseWindowReporting folder a patient exported — it should contain AnalyticalReport.pdf,
            Raw data.csv, and a DigitalSignature folder with hash.txt and public.txt.
          </p>
          <button
            className="secondary"
            onClick={() => folderInputRef.current?.click()}
            disabled={verifyStatus === "checking"}
          >
            {verifyStatus === "checking" ? "Checking…" : "Select folder"}
          </button>
          <input ref={folderInputRef} type="file" multiple hidden onChange={handleFolderSelect} />

          {verifyResult && (
            <div className={`verify-result verify-${verifyResult.status}`} role="status">
              <strong>
                {verifyResult.status === "valid" && "Verified"}
                {verifyResult.status === "invalid" && "Invalid"}
                {verifyResult.status === "unknown" && "Unknown key"}
                {verifyResult.status === "error" && "Could not verify"}
              </strong>
              <p>{verifyResult.message}</p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

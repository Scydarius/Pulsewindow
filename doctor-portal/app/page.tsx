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

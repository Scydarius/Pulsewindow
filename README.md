# PulseWindow

PulseWindow is a wellness prototype that estimates pulse rate and respiration rate from small colour changes in facial skin captured by a camera (rPPG). It includes a patient-facing web app, a doctor portal, and a native iPhone app, along with medication reminders and a pulse-and-medication history timeline.

Blood oxygen (SpO2) and blood pressure are deliberately not estimated from the camera — both require signal sources a standard RGB webcam doesn't have (SpO2 needs a calibrated infrared channel; BP needs pulse transit time between two synchronized measurement sites), so any camera-derived number for either would be fabricated rather than measured.

> PulseWindow is not a medical device and must not be used for diagnosis, emergencies, or medication changes. Follow instructions from a qualified clinician or pharmacist.

## Project folders

- `patient-app/` — browser version for desktop and mobile browsers; where patients monitor pulse, log medications, and export summaries
- `doctor-portal/` — separate app for clinicians; issues signed keys and verifies exported summaries
- `PulseWindow/` — native SwiftUI iPhone application
- `start_web_app.py` — simple local launcher for the patient app

## Run the patient app

```bash
cd patient-app
npm install
npm run dev
```

Then open `http://localhost:3000`.

### Dev mode

Camera hardware isn't always available (or working) while developing. Starting
the server with `VITE_DEV_MODE=true` adds a developer-only panel to the
monitor screen for entering a BPM value by hand, so the rest of the app
(saving readings, history, medication reminders) can be exercised without a
camera:

```bash
cd patient-app
VITE_DEV_MODE=true npm run dev
```

This flag is read once at startup and defaults to off, so it never appears
for normal users of a deployed build.

## Run the doctor portal

```bash
cd doctor-portal
npm install
npm run dev
```

Then open `http://localhost:3000` (or the next free port if the patient app is already running).

### Report verification

The two apps share a simple signing scheme (ECDSA P-256) so a doctor can confirm a patient's exported summary wasn't altered after it left their device:

1. In the doctor portal, under **Issue certification**, enter the patient's name and date of birth. This generates a key pair, saves the patient's name/DOB/ID and *public* key to a registry (kept in the browser, exportable as CSV), and displays both keys once for you to copy.
2. Give the patient their public and private key. The first time they open the patient app, it prompts for both before anything else is usable.
3. When the patient clicks **Export report**, they get a `PulseWindowReporting-<date>-<time>` folder containing:
   ```
   AnalyticalReport.pdf
   Raw data.csv
   DigitalSignature/
     hash.txt      (a signature over AnalyticalReport.pdf + Raw data.csv together)
     public.txt
   ```
   In a browser that supports the File System Access API (Chrome, Edge), this is written as a real folder wherever they choose. Elsewhere, it downloads as a `.zip` with the same layout.
4. In the doctor portal, under **Verify a report**, select that folder. The portal matches the public key against the registry to identify the patient, then checks the signature against the report.

The private key is never stored by the portal — only shown once at issuance — and the app only vouches for "this file is unmodified since export," not for the truthfulness of the underlying readings.

## Run the iPhone app

Open `PulseWindow/PulseWindow.xcodeproj` in Xcode, select a signed development team and an iPhone run destination, then press Run.


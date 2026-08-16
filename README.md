# PulseWindow

PulseWindow is a wellness prototype that estimates pulse rate from small colour changes in facial skin captured by a camera. It includes a web app and a native iPhone app, along with medication reminders and a pulse-and-medication history timeline.

> PulseWindow is not a medical device and must not be used for diagnosis, emergencies, or medication changes. Follow instructions from a qualified clinician or pharmacist.

## Project folders

- `web-app/` — browser version for desktop and mobile browsers
- `PulseWindow/` — native SwiftUI iPhone application
- `start_web_app.py` — simple local web-app launcher

## Run the web app

```bash
cd web-app
npm install
npm run dev
```

Then open `http://localhost:3000`.

## Run the iPhone app

Open `PulseWindow/PulseWindow.xcodeproj` in Xcode, select a signed development team and an iPhone run destination, then press Run.


import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appRoot = new URL("../app/", import.meta.url);

test("patient app includes the medication-centred monitoring workflow", async () => {
  const [page, layout] = await Promise.all([
    readFile(new URL("page.tsx", appRoot), "utf8"),
    readFile(new URL("layout.tsx", appRoot), "utf8"),
  ]);

  assert.match(layout, /Medication and Pulse Companion/);
  assert.match(page, /Add a medicine/);
  assert.match(page, /Photo of the packaging or tablet/);
  assert.match(page, /Add blood pressure/);
  assert.match(page, /Add a symptom/);
  assert.match(page, /Medication timeline/);
  assert.match(page, /Export report/);
  assert.match(page, /PulseWindow camera estimate/);
});

test("camera rPPG measurement remains available", async () => {
  const page = await readFile(new URL("page.tsx", appRoot), "utf8");
  assert.match(page, /Start pulse measurement/);
  assert.match(page, /greenBaselineRef/);
  assert.match(page, /estimateBPM/);
  assert.match(page, /FaceDetector/);
});

test("measurement plans, experimental breathing rate, and caregiver view are present", async () => {
  const page = await readFile(new URL("page.tsx", appRoot), "utf8");
  assert.match(page, /Import a measurement plan from your doctor/);
  assert.match(page, /estimateRespiratoryRate/);
  assert.match(page, /breaths\/min · experimental/);
  assert.match(page, /Open caregiver view/);
  assert.doesNotMatch(page, /Medication check-in/);
});

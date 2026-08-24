import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appRoot = new URL("../app/", import.meta.url);

test("doctor portal keeps signed-report verification", async () => {
  const [page, layout] = await Promise.all([
    readFile(new URL("page.tsx", appRoot), "utf8"),
    readFile(new URL("layout.tsx", appRoot), "utf8"),
  ]);

  assert.match(layout, /medication and monitoring summaries/);
  assert.match(page, /Doctor portal/);
  assert.match(page, /Issue certification/);
  assert.match(page, /verifyReportSignature/);
  assert.match(page, /AnalyticalReport\.pdf/);
  assert.match(page, /Raw data\.csv/);
});

test("doctor portal creates measurement-only plans", async () => {
  const page = await readFile(new URL("page.tsx", appRoot), "utf8");
  assert.match(page, /Create a measurement plan/);
  assert.match(page, /Breathing rate \(experimental\)/);
  assert.match(page, /never schedules medication-taking reminders/);
});

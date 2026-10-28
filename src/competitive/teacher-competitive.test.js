import assert from "node:assert/strict";
import test from "node:test";
import { competitiveDateTime, sortTeacherCompetitiveRows } from "./teacher-competitive.js";

const row = (fullName) => ({ studentId: fullName, fullName, attemptCount: 2, bestScore: 5, bestDurationMs: 3000, lastRunAt: "2026-10-28T10:00:00.000Z", lastRunDurationMs: 7000 });

test("teacher competitive results are sorted by the student's name", () => {
  assert.deepEqual(sortTeacherCompetitiveRows([row("Яна"), row("Андрій"), row("Богдан")]).map((item) => item.fullName), ["Андрій", "Богдан", "Яна"]);
});

test("teacher date formatter safely handles missing and valid timestamps", () => {
  assert.equal(competitiveDateTime(null), "—");
  assert.match(competitiveDateTime("2026-10-28T10:00:00.000Z"), /2026|28/);
});

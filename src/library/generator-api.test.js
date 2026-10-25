import test from "node:test";
import assert from "node:assert/strict";
import { buildGeneratorRequest, generateTest, generatorErrorMessage, selectApplicableConfig } from "./generator-api.js";

test("generator request trims optional title and preserves typed options", () => {
  assert.deepEqual(buildGeneratorRequest({ subjectId: "math-id", gradeLevel: "8", levelNumber: "3", mode: "graded", title: "  Таблиця  " }), {
    subjectId: "math-id", gradeLevel: 8, levelNumber: 3, mode: "graded", title: "Таблиця",
  });
  assert.deepEqual(buildGeneratorRequest({ subjectId: "math-id", gradeLevel: 3, levelNumber: 1, mode: "practice", title: " " }), {
    subjectId: "math-id", gradeLevel: 3, levelNumber: 1, mode: "practice",
  });
});

test("config lookup selects the nearest active lower grade for the chosen level", () => {
  const rows = [
    { grade_level: 3, level_number: 2, question_count: 10 },
    { grade_level: 5, level_number: 2, question_count: 12 },
    { grade_level: 7, level_number: 2, question_count: 20, active: false },
    { grade_level: 6, level_number: 1, question_count: 9 },
  ];
  assert.equal(selectApplicableConfig(rows, 6, 2), rows[1]);
  assert.equal(selectApplicableConfig(rows, 2, 2), null);
});

test("generation uses the typed function name and passes through the mocked API result", async () => {
  const request = buildGeneratorRequest({ subjectId: "math-id", gradeLevel: 5, levelNumber: 1, mode: "practice" });
  const expected = { ok: true, data: { templateId: "draft-id", title: "Множення", questionCount: 10, configGradeLevel: 3, settings: {} } };
  const calls = [];
  const result = await generateTest(request, async (name, body) => { calls.push({ name, body }); return expected; });
  assert.deepEqual(calls, [{ name: "generate-multiplication-test", body: request }]);
  assert.equal(result, expected);
});

test("generator API errors have clear Ukrainian messages", () => {
  assert.match(generatorErrorMessage("invalid_request"), /Перевірте/);
  assert.match(generatorErrorMessage("not_found"), /налаштувань/);
  assert.match(generatorErrorMessage("conflict"), /добовий ліміт/);
  assert.equal(generatorErrorMessage("internal"), null);
});

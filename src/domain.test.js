import assert from "node:assert/strict";
import test from "node:test";
import { assessmentDraftStorageKey, isAssessmentDraftCollection, migrateAssessmentDrafts, questionTypeLabels } from "./domain.ts";
import { apiErrorMessage, parseApiResult } from "./lib/function-api.ts";
import { validateAuthoredQuestion } from "./question-validation.ts";

test("migrates legacy subject ids while retaining draft data", () => {
  const oldDrafts = [
    { id: "math", subjectId: "math", title: "Math draft", grade: 3, questionType: "numeric", questionCount: 10, durationMinutes: 5, updatedAt: "today" },
    { id: "uk", subjectId: "ukrainian", title: "Language draft", grade: 2, questionType: "short_answer", questionCount: 10, durationMinutes: 5, updatedAt: "today" },
    { id: "en", subjectId: "english", title: "English draft", grade: 5, questionType: "multiple_choice", questionCount: 10, durationMinutes: 5, updatedAt: "today" },
    { id: "science", subjectId: "science", title: "Science draft", grade: 4, questionType: "true_false", questionCount: 10, durationMinutes: 5, updatedAt: "today" },
  ];

  assert.deepEqual(
    migrateAssessmentDrafts(oldDrafts),
    [
      { ...oldDrafts[0], subjectId: "mathematics" },
      { ...oldDrafts[1], subjectId: "ukrainian-language" },
      { ...oldDrafts[2], subjectId: "english-language" },
      oldDrafts[3],
    ],
  );
  assert.deepEqual(oldDrafts.map((draft) => draft.subjectId), ["math", "ukrainian", "english", "science"]);
});

test("returns null for an invalid stored draft collection", () => {
  assert.equal(migrateAssessmentDrafts({ subjectId: "math" }), null);
});

test("migrates the legacy choice type only for v1 drafts", () => {
  const draft = { id: "old", title: "Old", subjectId: "math", grade: 3, questionType: "multiple_choice", questionCount: 5, durationMinutes: 4, updatedAt: "today" };
  assert.equal(migrateAssessmentDrafts([draft], { legacyQuestionTypes: true })?.[0].questionType, "single_choice");
  assert.equal(migrateAssessmentDrafts([draft])?.[0].questionType, "multiple_choice");
  assert.equal(draft.subjectId, "math");
});

test("drops malformed items without throwing and detects incomplete legacy collections", () => {
  const valid = { id: "ok", title: "OK", subjectId: "math", grade: 3, questionType: "numeric", questionCount: 5, durationMinutes: 4, updatedAt: "today" };
  assert.deepEqual(migrateAssessmentDrafts([valid, null, "broken", {}]), [{ ...valid, subjectId: "mathematics" }]);
  assert.equal(isAssessmentDraftCollection([valid, null]), false);
  assert.equal(isAssessmentDraftCollection([valid]), true);
});

test("keeps every database question type distinguishable in the UI", () => {
  assert.deepEqual(Object.keys(questionTypeLabels), [
    "numeric",
    "short_answer",
    "single_choice",
    "multiple_choice",
    "true_false",
    "ordering",
    "matching",
  ]);
  assert.notEqual(questionTypeLabels.single_choice, questionTypeLabels.multiple_choice);
  assert.notEqual(questionTypeLabels.true_false, questionTypeLabels.single_choice);
  assert.equal(new Set(Object.values(questionTypeLabels)).size, Object.keys(questionTypeLabels).length);
});

test("parses API envelopes and maps access errors to Ukrainian UI copy", () => {
  assert.deepEqual(parseApiResult({ ok: true, data: { created: true } }), { ok: true, data: { created: true } });
  assert.deepEqual(parseApiResult({ ok: false, error: { code: "forbidden", message: "Forbidden" } }), {
    ok: false,
    error: { code: "forbidden", message: "Forbidden" },
  });
  assert.equal(parseApiResult({ ok: false, error: { code: "unknown", message: "Nope" } }), null);
  assert.match(apiErrorMessage("forbidden"), /не має доступу/);
});

test("draft storage is isolated by teacher identity and demo mode", () => {
  assert.notEqual(assessmentDraftStorageKey("teacher-a"), assessmentDraftStorageKey("teacher-b"));
  assert.equal(assessmentDraftStorageKey(null), "learning-studio-assessment-drafts-v2:demo");
});

test("question validation accepts the seven contract question shapes", () => {
  const base = { promptText: "Запитання?", points: 1 };
  const questions = [
    { ...base, type: "true_false", correct: true },
    { ...base, type: "single_choice", options: ["А", "Б", "В", "Г"], correctIndex: 1 },
    { ...base, type: "multiple_choice", options: ["А", "Б", "В"], correctIndexes: [0] },
    { ...base, type: "ordering", itemsInCorrectOrder: ["А", "Б", "В"] },
    { ...base, type: "matching", pairs: [{ left: "А", right: "Б" }, { left: "В", right: "Г" }] },
    { ...base, type: "numeric", value: 42, tolerance: 0 },
    { ...base, type: "short_answer", accepted: ["відповідь"], caseSensitive: false },
  ];
  for (const question of questions) assert.deepEqual(validateAuthoredQuestion(question), [], question.type);
});

test("question validation enforces contract option and answer limits", () => {
  assert.match(validateAuthoredQuestion({ promptText: "x", points: 1, type: "single_choice", options: ["A", "B", "C"], correctIndex: 0 }).join(" "), /4–5/);
  assert.match(validateAuthoredQuestion({ promptText: "x", points: 1, type: "single_choice", options: ["A", "B", "C", "D"], correctIndex: null }).join(" "), /Позначте один/);
  assert.match(validateAuthoredQuestion({ promptText: "x", points: 1, type: "multiple_choice", options: ["A", "B", "C"], correctIndexes: [] }).join(" "), /щонайменше один/);
  assert.match(validateAuthoredQuestion({ promptText: "x", points: 1, type: "matching", pairs: [{ left: "A", right: "B" }] }).join(" "), /2–8/);
  assert.match(validateAuthoredQuestion({ promptText: "x", points: 1, type: "short_answer", accepted: [] }).join(" "), /1–10/);
  assert.ok(validateAuthoredQuestion({ promptText: "x", points: 0, type: "numeric", value: 1 }).length > 0);
});

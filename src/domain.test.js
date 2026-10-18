import assert from "node:assert/strict";
import test from "node:test";
import { migrateAssessmentDrafts, questionTypeLabels } from "./domain.ts";

test("migrates legacy subject ids while retaining draft data", () => {
  const oldDrafts = [
    { id: "math", subjectId: "math", title: "Math draft", grade: 3, questionType: "numeric" },
    { id: "uk", subjectId: "ukrainian", title: "Language draft", grade: 2, questionType: "short_answer" },
    { id: "en", subjectId: "english", title: "English draft", grade: 5, questionType: "multiple_choice" },
    { id: "science", subjectId: "science", title: "Science draft", grade: 4, questionType: "true_false" },
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

test("keeps every database question type distinguishable in the UI", () => {
  assert.deepEqual(Object.keys(questionTypeLabels), [
    "numeric",
    "short_answer",
    "single_choice",
    "multiple_choice",
    "true_false",
  ]);
  assert.notEqual(questionTypeLabels.single_choice, questionTypeLabels.multiple_choice);
  assert.notEqual(questionTypeLabels.true_false, questionTypeLabels.single_choice);
});

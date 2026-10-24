import test from "node:test";
import assert from "node:assert/strict";
import { formatScore, partialCreditHint, practiceFeedbackText, teacherQuestionScoreLabel } from "./scoring.js";

test("scores retain up to two decimal places without padding", () => {
  assert.equal(formatScore(2.5), "2.5");
  assert.equal(formatScore("2.50"), "2.5");
  assert.equal(formatScore(2.567), "2.57");
  assert.equal(formatScore(4), "4");
  assert.equal(formatScore(null), "—");
  assert.equal(formatScore(0), "0");
  assert.equal(formatScore("not-a-score"), "—");
});

test("practice feedback distinguishes full, partial and zero credit", () => {
  assert.equal(practiceFeedbackText({ isCorrect: true, awardedPoints: 4 }, 4), "Правильно! · 4 з 4 балів.");
  assert.equal(practiceFeedbackText({ isCorrect: false, awardedPoints: 2.5 }, 4), "Частково: 2.5 з 4 балів.");
  assert.match(practiceFeedbackText({ isCorrect: false, awardedPoints: 0 }, 4), /Наступне запитання/);
});

test("partial-credit hints are available for the three multi-part question types", () => {
  for (const type of ["multiple_choice", "ordering", "matching"]) {
    assert.ok(partialCreditHint(type).length > 10);
  }
  assert.equal(partialCreditHint("numeric"), "");
});

test("teacher result labels distinguish partial scores and preserve score precision", () => {
  assert.equal(teacherQuestionScoreLabel(false, 2.5, 4), "Частково · 2.5 з 4 балів");
  assert.equal(teacherQuestionScoreLabel(true, 4, 4), "Правильно · 4 з 4 балів");
  assert.equal(teacherQuestionScoreLabel(false, 0, 4), "Неправильно · 0 з 4 балів");
});

import test from "node:test";
import assert from "node:assert/strict";
import { STUDENT_AUTH_ERROR, STUDENT_LOGIN_PATTERN, STUDENT_PASSWORD_PATTERN, assignmentWindow, clearAttemptDraft, correctedNow, publicFeedback, readAttemptDraft, remainingSeconds, responseForQuestion, studentApiMessage, studentAuthError, studentEmail, writeAttemptDraft } from "./student-flow.js";

test("student login builds a hidden synthetic email from the configured domain", () => {
  assert.equal(studentEmail(" ABcd ", "students.local.invalid"), "abcd@students.local.invalid");
  assert.equal(studentEmail("ab1d", "students.local.invalid"), null);
  assert.equal(studentEmail("abcd", ""), null);
  assert.equal(STUDENT_LOGIN_PATTERN.test("abcd"), true);
  assert.equal(STUDENT_LOGIN_PATTERN.test("abio"), false);
  assert.equal(STUDENT_PASSWORD_PATTERN.test("ab1234"), true);
});

test("all seven public question types create only contract-shaped answer responses", () => {
  const cases = [
    [{ type: "true_false" }, true, { type: "true_false", value: true }],
    [{ type: "single_choice", choices: [{ id: "c1" }] }, "c1", { type: "single_choice", choiceId: "c1" }],
    [{ type: "multiple_choice", choices: [{ id: "c1" }, { id: "c2" }] }, ["c1", "c2"], { type: "multiple_choice", choiceIds: ["c1", "c2"] }],
    [{ type: "ordering", choices: [{ id: "c1" }, { id: "c2" }] }, ["c2", "c1"], { type: "ordering", order: ["c2", "c1"] }],
    [{ type: "matching", items: [{ id: "l1", side: "left" }, { id: "r1", side: "right" }] }, [{ leftId: "l1", rightId: "r1" }], { type: "matching", pairs: [{ leftId: "l1", rightId: "r1" }] }],
    [{ type: "numeric" }, "42", { type: "numeric", text: "42" }],
    [{ type: "short_answer" }, "слово", { type: "short_answer", text: "слово" }],
  ];
  for (const [question, value, expected] of cases) assert.deepEqual(responseForQuestion(question, value), expected);
  assert.equal(responseForQuestion({ type: "numeric" }, "  "), null);
  assert.equal(responseForQuestion({ type: "matching", items: [{ id: "l1", side: "left" }, { id: "r1", side: "right" }] }, [{ leftId: "l1" }]), null);
  assert.equal(responseForQuestion({ type: "matching", items: [{ id: "l1", side: "left" }, { id: "r1", side: "right" }] }, { pairs: [], selectedLeft: "l1" }), null);
});

test("server time corrects a device clock and computes a display-only countdown", () => {
  const receivedAt = Date.parse("2026-10-23T10:00:00Z");
  const serverNow = "2026-10-23T10:00:10Z";
  assert.equal(correctedNow(serverNow, receivedAt, receivedAt + 2_000), receivedAt + 12_000);
  assert.equal(remainingSeconds("2026-10-23T10:01:00Z", serverNow, receivedAt, receivedAt + 2_000), 48);
});

test("assignment availability follows the opens and closes instants", () => {
  const now = Date.parse("2026-10-23T10:00:00Z");
  assert.equal(assignmentWindow("2026-10-23T10:01:00Z", null, now), "upcoming");
  assert.equal(assignmentWindow(null, "2026-10-23T09:59:00Z", now), "closed");
  assert.equal(assignmentWindow(null, null, now), "open");
});

test("answer drafts survive storage reloads and clear only after acceptance", () => {
  const map = new Map();
  const storage = { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: (key) => map.delete(key), get length() { return map.size; }, key: (index) => [...map.keys()][index] };
  assert.equal(writeAttemptDraft(storage, "attempt-1", "question-1", { type: "numeric", text: "14" }), true);
  assert.deepEqual(readAttemptDraft(storage, "attempt-1"), { "question-1": { type: "numeric", text: "14" } });
  clearAttemptDraft(storage, "attempt-1", "question-1");
  assert.deepEqual(readAttemptDraft(storage, "attempt-1"), {});
});

test("all login failures share one generic message and API errors map to Ukrainian", () => {
  assert.equal(studentAuthError("invalid_login"), STUDENT_AUTH_ERROR);
  assert.equal(studentAuthError("network"), STUDENT_AUTH_ERROR);
  assert.match(studentApiMessage("retry_not_allowed"), /Повторна спроба/);
  assert.match(studentApiMessage("attempt_expired"), /завершився/);
  assert.match(studentApiMessage("internal"), /залишилася на пристрої/);
});

test("mock attempt responses reveal feedback in practice only and keep graded opaque", () => {
  const mock = { ok: true, data: { accepted: true, feedback: { isCorrect: false, awardedPoints: 0 } } };
  assert.deepEqual(publicFeedback("practice", mock), { isCorrect: false, awardedPoints: 0 });
  assert.equal(publicFeedback("graded", mock), null);
  assert.equal(publicFeedback("practice", { ok: false, error: { code: "attempt_expired" } }), null);
});

test("attempt error fixtures preserve actionable responses without exposing server text", () => {
  const failures = ["attempt_expired", "already_answered", "retry_not_allowed", "assignment_not_open", "assignment_closed", "internal"];
  for (const code of failures) {
    const mock = { ok: false, error: { code, message: "private server detail" } };
    assert.equal(studentApiMessage(mock.error.code).includes(mock.error.message), false);
    assert.ok(studentApiMessage(mock.error.code).length > 5);
  }
});

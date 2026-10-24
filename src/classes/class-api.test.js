import test from "node:test";
import assert from "node:assert/strict";
import { assignmentClassAvailability, assignmentNoCompatibleClassMessage, buildClassRequest, classFunctionMessage, classSelectionAfterRefresh, saveClass, validateClassInput } from "./class-api.js";

test("class input trims names and accepts grades 1 through 11", () => {
  assert.deepEqual(validateClassInput("  8-А  ", "8", "subject-id"), {
    ok: true, name: "8-А", gradeLevel: 8, subjectId: "subject-id",
  });
  assert.equal(validateClassInput("8", 1, "s").ok, true);
  assert.equal(validateClassInput("8", 11, "s").ok, true);
});

test("class input rejects blank or overlong names, invalid grades, and missing subjects", () => {
  assert.deepEqual(validateClassInput("  ", 8, "s"), { ok: false, reason: "name" });
  assert.deepEqual(validateClassInput("x".repeat(81), 8, "s"), { ok: false, reason: "name" });
  assert.deepEqual(validateClassInput("8", 0, "s"), { ok: false, reason: "grade" });
  assert.deepEqual(validateClassInput("8", 12, "s"), { ok: false, reason: "grade" });
  assert.deepEqual(validateClassInput("8", 2.5, "s"), { ok: false, reason: "grade" });
  assert.deepEqual(validateClassInput("8", 8, ""), { ok: false, reason: "subject" });
});

test("class errors give distinct duplicate-name and assignment-locked explanations", () => {
  assert.match(classFunctionMessage("conflict", "create"), /такою назвою/);
  assert.match(classFunctionMessage("conflict", "configure"), /вже є призначення/);
  assert.match(classFunctionMessage("invalid_request", "create"), /1 до 11/);
  assert.match(classFunctionMessage("not_found", "create"), /не знайдено/);
  assert.match(classFunctionMessage("forbidden", "configure"), /Немає доступу/);
  assert.match(classFunctionMessage("internal", "create"), /тимчасову помилку/);
});

test("class list refresh selects the newly created class and falls back to an available class", () => {
  const rows = [{ id: "first" }, { id: "created" }];
  assert.equal(classSelectionAfterRefresh(rows, "first", "created"), "created");
  assert.equal(classSelectionAfterRefresh(rows, "missing"), "first");
  assert.equal(classSelectionAfterRefresh([], "missing"), "");
});

test("assignment empty state explains the exact subject and grade requirement", () => {
  assert.equal(assignmentClassAvailability(0, 0), "none-compatible");
  assert.equal(assignmentClassAvailability(2, 0), "already-assigned");
  assert.equal(assignmentClassAvailability(2, 1), "available");
  assert.equal(assignmentNoCompatibleClassMessage(8, "Математика"), "Немає вашого класу 8 рівня з предметом «Математика».");
});

test("create and configure use the typed API request names and camel-case payloads", () => {
  assert.deepEqual(buildClassRequest("create", { name: "  8-А ", subjectId: "math-id", gradeLevel: 8 }), {
    name: "create-class", body: { name: "8-А", subjectId: "math-id", gradeLevel: 8 },
  });
  assert.deepEqual(buildClassRequest("configure", { classId: "class-id", subjectId: "math-id", gradeLevel: 8 }), {
    name: "set-class-subject", body: { classId: "class-id", subjectId: "math-id", gradeLevel: 8 },
  });
});

test("class creation succeeds through the injected API mock", async () => {
  const calls = [];
  const result = await saveClass("create", { name: "7-А", subjectId: "math", gradeLevel: 7 }, async (name, body) => {
    calls.push({ name, body });
    return { ok: true, data: { classId: "new-class", schoolId: "school", name: body.name, subjectId: body.subjectId, gradeLevel: body.gradeLevel } };
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.classId, "new-class");
  assert.deepEqual(calls, [{ name: "create-class", body: { name: "7-А", subjectId: "math", gradeLevel: 7 } }]);
});

test("create conflict and configure not_found remain structured API errors", async () => {
  const invoke = async (name) => ({
    ok: false,
    error: { code: name === "create-class" ? "conflict" : "not_found", message: "server detail" },
  });
  const conflict = await saveClass("create", { name: "7-А", subjectId: "math", gradeLevel: 7 }, invoke);
  const notFound = await saveClass("configure", { classId: "missing", subjectId: "math", gradeLevel: 7 }, invoke);
  assert.equal(conflict.error.code, "conflict");
  assert.equal(classFunctionMessage(conflict.error.code, "create"), "Клас із такою назвою вже існує в школі.");
  assert.equal(notFound.error.code, "not_found");
  assert.match(classFunctionMessage(notFound.error.code, "configure"), /не знайдено/);
});

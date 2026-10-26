import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BANK_LEVEL_COUNTS, buildBankRequest, normalizeLevelCounts, summarizeBank,
  filterBankQuestions, buildBulkUpdateRequest, bankErrorMessage, generateBank, bulkUpdateBank,
} from "./bank-api.js";

test("bank request defaults to five/t en/ten/five/zero and omits blank title", () => {
  assert.deepEqual(DEFAULT_BANK_LEVEL_COUNTS, [5, 10, 10, 5, 0]);
  assert.deepEqual(buildBankRequest({ subjectId: "subject", gradeLevel: "4", mode: "practice", title: " " }), {
    subjectId: "subject", gradeLevel: 4, mode: "practice", levelCounts: [5, 10, 10, 5, 0],
  });
});

test("bank count sum accepts 1..100 only", () => {
  assert.deepEqual(normalizeLevelCounts([1, 0, 0, 0, 0]), [1, 0, 0, 0, 0]);
  assert.equal(normalizeLevelCounts([0, 0, 0, 0, 0]), null);
  assert.equal(normalizeLevelCounts([101, 0, 0, 0, 0]), null);
  assert.equal(normalizeLevelCounts([1, -1, 0, 0, 0]), null);
  assert.throws(() => buildBankRequest({ subjectId: "s", gradeLevel: 3, mode: "graded", levelCounts: [0,0,0,0,0] }), RangeError);
});

test("bank summary reports missing questions by difficulty", () => {
  assert.deepEqual(summarizeBank([7, 10, 8, 5, 0], [5, 10, 10, 5, 0]), {
    have: [7, 10, 8, 5, 0], need: [5, 10, 10, 5, 0], missing: [0, 0, 2, 0, 0], total: 30, complete: false,
  });
});

test("filter supports difficulty, case-insensitive search and pagination", () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({ id: String(index), promptText: index === 1 ? "Таблиця Множення" : "Приклад", difficulty: index % 2 + 1 }));
  const first = filterBankQuestions(rows, { level: 2, search: "МНОЖЕННЯ", pageSize: 1 });
  assert.equal(first.filteredCount, 1);
  assert.equal(first.items[0].id, "1");
  assert.equal(filterBankQuestions(rows, { level: 1, page: 2, pageSize: 5 }).items.length, 5);
});

test("bulk requests match the contract and map server errors in Ukrainian", () => {
  assert.deepEqual(buildBulkUpdateRequest("template", ["q1"], { difficulty: 3, points: 2, timeLimitSeconds: null }), {
    templateId: "template", questionIds: ["q1"], update: { difficulty: 3, points: 2, timeLimitSeconds: null },
  });
  assert.deepEqual(buildBulkUpdateRequest("template", ["q1"], { delete: true }), { templateId: "template", questionIds: ["q1"], delete: true });
  assert.equal(bankErrorMessage("incomplete_assessment"), "У банку недостатньо запитань одного або кількох рівнів складності.");
});

test("bank actions call the matching typed function names with the supplied payload", async () => {
  const calls = [];
  const callFunction = async (name, body) => { calls.push({ name, body }); return { ok: true, data: { affected: 1 } }; };
  const createRequest = buildBankRequest({ subjectId: "subject", gradeLevel: 3, mode: "practice" });
  const updateRequest = buildBulkUpdateRequest("template", ["q1"], { difficulty: 2 });
  await generateBank(createRequest, callFunction);
  await bulkUpdateBank(updateRequest, callFunction);
  assert.deepEqual(calls.map((call) => call.name), ["generate-multiplication-bank", "bulk-update-questions"]);
  assert.deepEqual(calls.map((call) => call.body), [createRequest, updateRequest]);
});

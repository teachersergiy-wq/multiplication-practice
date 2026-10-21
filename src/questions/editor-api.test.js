import test from "node:test";
import assert from "node:assert/strict";
import {
  deleteQuestionRequest,
  getDraftRequest,
  reorderQuestionsRequest,
  upsertQuestionRequest,
} from "./editor-api.js";

const templateId = "template-1";
const samples = [
  { type: "true_false", promptText: "Prompt", points: 1, correct: true },
  { type: "single_choice", promptText: "Prompt", points: 1, options: ["a", "b", "c", "d"], correctIndex: 2 },
  { type: "multiple_choice", promptText: "Prompt", points: 1, options: ["a", "b", "c"], correctIndexes: [0, 2] },
  { type: "ordering", promptText: "Prompt", points: 1, itemsInCorrectOrder: ["a", "b", "c"] },
  { type: "matching", promptText: "Prompt", points: 1, pairs: [{ left: "a", right: "1" }, { left: "b", right: "2" }] },
  { type: "numeric", promptText: "Prompt", points: 1, value: 42, tolerance: 0 },
  { type: "short_answer", promptText: "Prompt", points: 1, accepted: ["answer"], caseSensitive: false },
];

test("draft loading, seven authored types and editor mutations use contract request shapes", async () => {
  const requests = [];
  const mockFunctions = {
    async invoke(name, options) {
      requests.push({ name, body: options.body });
      return { data: { ok: true, data: name === "upsert-question" ? { questionId: "question-1" } : { reordered: true } }, error: null };
    },
  };

  const loadRequest = getDraftRequest(templateId);
  assert.deepEqual(loadRequest, { templateId });
  const loaded = await mockFunctions.invoke("get-assessment-draft", { body: loadRequest });
  assert.equal(loaded.data.ok, true);

  for (const question of samples) {
    const body = upsertQuestionRequest(templateId, undefined, question);
    const response = await mockFunctions.invoke("upsert-question", { body });
    assert.equal(response.data.ok, true);
    assert.deepEqual(body.question, question);
    assert.equal("questionId" in body, false);
  }

  assert.deepEqual(deleteQuestionRequest("question-1"), { questionId: "question-1" });
  const order = reorderQuestionsRequest(templateId, ["question-2", "question-1"]);
  assert.deepEqual(order, { templateId, orderedQuestionIds: ["question-2", "question-1"] });
  await mockFunctions.invoke("reorder-questions", { body: order });
  assert.equal(requests.filter(({ name }) => name === "upsert-question").length, 7);
  assert.equal(requests[0].name, "get-assessment-draft");
  assert.equal(requests.at(-1).name, "reorder-questions");
});

test("editing an existing question includes its id and preserves the answer key only in the request body", () => {
  const edited = upsertQuestionRequest(templateId, "question-1", samples[3]);
  assert.deepEqual(edited, { templateId, questionId: "question-1", question: samples[3] });
  assert.equal(JSON.stringify(edited).includes("localStorage"), false);
});


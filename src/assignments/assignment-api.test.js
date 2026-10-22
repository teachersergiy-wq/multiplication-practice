import test from "node:test";
import assert from "node:assert/strict";
import { createAssignment, deleteAssignment, fromDateTimeLocal, isValidAssignmentWindow, publishDraft, toDateTimeLocal, updateAssignmentWindow, validateQuestionsForPublication } from "./assignment-api.js";

function mutationClient({ data = { id: "row-1" }, error = null, thrown = null } = {}) {
  const calls = [];
  const builder = {
    update(value) { calls.push(["update", value]); return this; },
    insert(value) { calls.push(["insert", value]); return this; },
    delete() { calls.push(["delete"]); return this; },
    eq(key, value) { calls.push(["eq", key, value]); return this; },
    select(value) { calls.push(["select", value]); return this; },
    async maybeSingle() { if (thrown) throw thrown; return { data, error }; },
  };
  return { calls, from(table) { calls.push(["from", table]); return builder; } };
}

const assignment = {
  template_id: "template-1", class_id: "class-1", assigned_by: "teacher-1",
  opens_at: null, closes_at: "2026-11-01T12:00:00.000Z", allow_retries: false,
};

test("publishes through the contract after saving only the selected draft mode", async () => {
  const client = mutationClient();
  const requests = [];
  const result = await publishDraft(client, "template-1", "teacher-1", "graded", async (_client, name, body) => {
    requests.push({ name, body });
    return { ok: true, data: { templateId: "template-1", status: "published", questionCount: 3, totalPoints: 3 } };
  });
  assert.equal(result.ok, true);
  assert.deepEqual(requests, [{ name: "publish-assessment", body: { templateId: "template-1" } }]);
  assert.ok(client.calls.some((call) => call[0] === "update" && JSON.stringify(call[1]) === '{"mode":"graded"}'));
  assert.ok(!client.calls.some((call) => call[0] === "update" && "status" in call[1]));
});

test("surfaces incomplete assessment and conflict responses from publish-assessment", async () => {
  for (const code of ["incomplete_assessment", "conflict"]) {
    const result = await publishDraft(mutationClient(), "template-1", "teacher-1", "practice", async () => ({
      ok: false, error: { code, message: "request failed" },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
  }
});

test("publication validation requires saved questions and rejects invalid question records", () => {
  const isValidQuestion = (question) => question.valid === true;
  assert.deepEqual(validateQuestionsForPublication([], isValidQuestion), { ok: false, reason: "empty" });
  assert.deepEqual(validateQuestionsForPublication([{ valid: false }], isValidQuestion), { ok: false, reason: "invalid" });
  assert.deepEqual(validateQuestionsForPublication([{ valid: true }], isValidQuestion), { ok: true });
});

test("assignment create, window update and cancel use mocked Supabase responses", async () => {
  assert.deepEqual(await createAssignment(mutationClient(), assignment), { ok: true, id: "row-1" });
  assert.deepEqual(await updateAssignmentWindow(mutationClient(), "assignment-1", { opensAt: null, closesAt: null, allowRetries: true }), { ok: true, id: "row-1" });
  assert.deepEqual(await deleteAssignment(mutationClient(), "assignment-1"), { ok: true, id: "row-1" });
});

test("reports duplicate, RLS, foreign-key and zero-row mutation results", async () => {
  assert.deepEqual(await createAssignment(mutationClient({ error: { code: "23505" } }), assignment), { ok: false, reason: "duplicate" });
  assert.deepEqual(await updateAssignmentWindow(mutationClient({ error: { code: "42501" } }), "assignment-1", { opensAt: null, closesAt: null, allowRetries: true }), { ok: false, reason: "permission" });
  assert.deepEqual(await deleteAssignment(mutationClient({ error: { code: "23503" } }), "assignment-1"), { ok: false, reason: "referenced" });
  assert.deepEqual(await deleteAssignment(mutationClient({ data: null }), "assignment-1"), { ok: false, reason: "not_found" });
});

test("a failed draft update or network exception never calls publish", async () => {
  let calls = 0;
  const invoke = async () => { calls++; return { ok: true, data: { templateId: "template-1", status: "published", questionCount: 1, totalPoints: 1 } }; };
  assert.deepEqual(await publishDraft(mutationClient({ data: null }), "template-1", "teacher-1", "practice", invoke), { ok: false, reason: "not_found" });
  assert.deepEqual(await publishDraft(mutationClient({ thrown: new Error("network") }), "template-1", "teacher-1", "practice", invoke), { ok: false, reason: "database" });
  assert.equal(calls, 0);
});

test("local date fields convert to ISO and reject a closing time before opening", () => {
  const local = toDateTimeLocal("2026-10-23T10:00:00.000Z");
  assert.equal(fromDateTimeLocal(local), "2026-10-23T10:00:00.000Z");
  assert.equal(isValidAssignmentWindow("2026-10-23T12:00:00.000Z", "2026-10-23T11:00:00.000Z"), false);
  assert.equal(isValidAssignmentWindow("", "2026-10-23T11:00:00.000Z"), true);
});

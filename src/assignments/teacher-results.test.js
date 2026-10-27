import test from "node:test";
import "../library/bank-api.test.js";
import assert from "node:assert/strict";
import { formatElapsed, formatQuestionSeconds, formatStudentAnswer, loadAssignmentResults, loadAttemptTiming, prepareAttemptTiming, statusLabel, summarizeAssignmentResults } from "./teacher-results.js";

function mockClient(responses) {
  const calls = [];
  return {
    calls,
    from(table) {
      calls.push(table);
      const response = responses[table] ?? { data: [], error: null };
      const query = {
        select() { return query; },
        eq() { return query; },
        order() { return query; },
        in() { return query; },
        then(resolve, reject) { return Promise.resolve(response).then(resolve, reject); },
      };
      return query;
    },
  };
}

const student = { id: "student-a", name: "Учень А" };
const q1 = { id: "q1", question_type: "single_choice", prompt: { text: "Скільки буде 2 + 2?" }, choices: [{ id: "c1", text: "4" }, { id: "c2", text: "5" }], points: 2, position: 1 };
const q2 = { id: "q2", question_type: "numeric", prompt: { text: "Скільки буде 3 + 3?" }, choices: [], points: 1, position: 2 };
const finished = (id, studentId = student.id, score = 2, startedAt = "2026-10-24T10:00:00Z") => ({
  id, student_id: studentId, status: "completed", started_at: startedAt, finished_at: startedAt,
  score, max_score: 3, passed: false, elapsed_ms: 65_000,
});

test("empty assignment results identify students who have not started", async () => {
  const client = mockClient({
    class_students: { data: [{ student_id: student.id, profiles: { full_name: student.name } }], error: null },
    assessment_attempts: { data: [], error: null },
    assessment_questions: { data: [q1], error: null },
  });
  const loaded = await loadAssignmentResults(client, { assignmentId: "a", classId: "c", templateId: "t" });
  assert.equal(loaded.ok, true);
  assert.equal(client.calls.includes("assessment_responses"), false);
  assert.equal(summarizeAssignmentResults(loaded.data).rows[0].status, "not_started");
  assert.equal(summarizeAssignmentResults(loaded.data).completedStudentCount, 0);
});

test("in-progress attempts show status without reading their responses", async () => {
  const client = mockClient({
    class_students: { data: [{ student_id: student.id, profiles: [ { full_name: student.name } ] }], error: null },
    assessment_attempts: { data: [{ ...finished("active"), status: "in_progress", finished_at: null, score: null, max_score: null }], error: null },
    assessment_questions: { data: [q1], error: null },
  });
  const loaded = await loadAssignmentResults(client, { assignmentId: "a", classId: "c", templateId: "t" });
  assert.equal(summarizeAssignmentResults(loaded.data).rows[0].status, "in_progress");
  assert.equal(client.calls.includes("assessment_responses"), false);
});

test("completed attempts summarize score and count an unanswered question as a mistake", () => {
  const data = {
    students: [student], attempts: [finished("done")], questions: [q1, q2],
    responses: [{ attempt_id: "done", question_id: "q1", response: { type: "single_choice", choiceId: "c2" }, is_correct: false, awarded_points: 0 }],
  };
  const summary = summarizeAssignmentResults(data);
  assert.equal(summary.completedStudentCount, 1);
  assert.equal(summary.averagePercent, 66.67);
  assert.deepEqual(summary.mostCommonErrors.map((item) => [item.question.id, item.count]), [["q1", 1], ["q2", 1]]);
  assert.equal(formatStudentAnswer(q1, data.responses[0]), "5");
});

test("multiple attempts keep the latest completed score while an active attempt is shown", () => {
  const older = finished("old", student.id, 1, "2026-10-23T10:00:00Z");
  const newest = finished("new", student.id, 3, "2026-10-24T09:00:00Z");
  const active = { ...finished("active", student.id, null, "2026-10-24T11:00:00Z"), status: "in_progress", finished_at: null, score: null, max_score: null };
  const summary = summarizeAssignmentResults({ students: [student], attempts: [older, active, newest], questions: [q1], responses: [] });
  assert.equal(summary.rows[0].attemptCount, 3);
  assert.equal(summary.rows[0].status, "in_progress");
  assert.equal(summary.rows[0].latestCompleted.id, "new");
  assert.equal(summary.averagePercent, 100);
});

test("a database read failure returns a recoverable error state", async () => {
  const client = mockClient({
    class_students: { data: null, error: { message: "read denied" } },
    assessment_attempts: { data: [], error: null },
    assessment_questions: { data: [], error: null },
  });
  const loaded = await loadAssignmentResults(client, { assignmentId: "a", classId: "c", templateId: "t" });
  assert.deepEqual(loaded, { ok: false });
});

test("answer and duration formatters cover answer types and terminal statuses", () => {
  assert.equal(formatStudentAnswer({ ...q1, question_type: "true_false" }, { response: { type: "true_false", value: true } }), "Так");
  assert.equal(formatStudentAnswer({ ...q1, choices: [{ id: "left", text: "Кіт" }, { id: "right", text: "Cat" }] }, { response: { type: "matching", pairs: [{ leftId: "left", rightId: "right" }] } }), "Кіт — Cat");
  assert.equal(formatStudentAnswer(q1, null), "Немає відповіді");
  assert.equal(formatElapsed(65_000), "1 хв 5 с");
  assert.equal(statusLabel("abandoned"), "Спробу перервано");
});

test("teacher result details count only questions sampled for each attempt", async () => {
  const client = mockClient({
    class_students: { data: [{ student_id: student.id, profiles: { full_name: student.name } }], error: null },
    assessment_attempts: { data: [finished("sampled")], error: null },
    assessment_attempt_questions: { data: [{ attempt_id: "sampled", question_id: "q2", position: 1 }], error: null },
    assessment_questions: { data: [q2], error: null },
    assessment_responses: { data: [{ attempt_id: "sampled", question_id: "q2", response: { type: "numeric", text: "6" }, is_correct: true, awarded_points: 1 }], error: null },
  });
  const loaded = await loadAssignmentResults(client, { assignmentId: "a", classId: "c", templateId: "t" });
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.data.questionsByAttempt.get("sampled").map((question) => question.id), ["q2"]);
  assert.deepEqual(summarizeAssignmentResults(loaded.data).mostCommonErrors, []);
});

test("question timing formatter rounds to one decimal and handles null values", () => {
  assert.equal(formatQuestionSeconds(4.25), "4,3 с");
  assert.equal(formatQuestionSeconds(3.181), "3,2 с");
  assert.equal(formatQuestionSeconds(0), "0,0 с");
  assert.equal(formatQuestionSeconds(null), "—");
  assert.equal(formatQuestionSeconds(undefined), "—");
  assert.equal(formatQuestionSeconds("not-a-number"), "—");
});

test("attempt timing preparation sorts by position and preserves nullable correctness", () => {
  const prepared = prepareAttemptTiming({
    attemptId: "timed-attempt",
    questions: [
      { questionId: "q3", position: 3, answerSeconds: null, isCorrect: null },
      { questionId: "q1", position: 1, answerSeconds: 4.25, isCorrect: true },
      { questionId: "q2", position: 2, answerSeconds: "3.18", isCorrect: false },
    ],
    summary: { avgSeconds: 3.715, medianSeconds: 3.18, minSeconds: 3.18, maxSeconds: 4.25 },
  });
  assert.ok(prepared);
  assert.deepEqual(prepared.questions.map((question) => question.questionId), ["q1", "q2", "q3"]);
  assert.equal(prepared.questions[2].answerSeconds, null);
  assert.equal(prepared.questions[2].isCorrect, null);
  assert.deepEqual(prepared.summary, { avgSeconds: 3.715, medianSeconds: 3.18, minSeconds: 3.18, maxSeconds: 4.25 });
});

test("empty attempt timing has blank summary values", () => {
  const prepared = prepareAttemptTiming({
    attemptId: "empty-attempt",
    questions: [],
    summary: { avgSeconds: 9, medianSeconds: 9, minSeconds: 9, maxSeconds: 9 },
  });
  assert.deepEqual(prepared, {
    attemptId: "empty-attempt",
    questions: [],
    summary: { avgSeconds: null, medianSeconds: null, minSeconds: null, maxSeconds: null },
  });
  const unanswered = prepareAttemptTiming({
    attemptId: "unanswered-attempt",
    questions: [{ questionId: "q1", position: 1, answerSeconds: null, isCorrect: null }],
    summary: { avgSeconds: 9, medianSeconds: 9, minSeconds: 9, maxSeconds: 9 },
  });
  assert.deepEqual(unanswered.summary, { avgSeconds: null, medianSeconds: null, minSeconds: null, maxSeconds: null });
});

test("attempt timing RPC uses teacher and attempt ids and prepares response", async () => {
  const calls = [];
  const client = {
    async rpc(name, params) {
      calls.push({ name, params });
      return {
        error: null,
        data: {
          attemptId: "attempt-a",
          questions: [{ questionId: "q1", position: 1, answerSeconds: 4.2, isCorrect: true }],
          summary: { avgSeconds: 4.2, medianSeconds: 4.2, minSeconds: 4.2, maxSeconds: 4.2 },
        },
      };
    },
  };
  const loaded = await loadAttemptTiming(client, { teacherId: "teacher-a", attemptId: "attempt-a" });
  assert.deepEqual(calls, [{
    name: "api_teacher_attempt_timing",
    params: { p_teacher_id: "teacher-a", p_attempt_id: "attempt-a" },
  }]);
  assert.equal(loaded.ok, true);
  if (loaded.ok) assert.equal(loaded.data.questions[0].questionId, "q1");
});

test("attempt timing hides errors for attempts that are not available to this teacher", async () => {
  const loaded = await loadAttemptTiming({
    async rpc() { return { data: null, error: { message: "not_found: attempt unavailable" } }; },
  }, { teacherId: "teacher-a", attemptId: "other-teachers-attempt" });
  assert.deepEqual(loaded, { ok: false, reason: "not_found" });
});

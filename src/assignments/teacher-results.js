function relationOne(value) {
  return Array.isArray(value) ? value[0] ?? null : value;
}

export async function loadAssignmentResults(client, { assignmentId, classId, templateId }) {
  const db = client;
  const [studentsResult, attemptsResult, questionsResult] = await Promise.all([
    db.from("class_students").select("student_id, profiles!inner(full_name)").eq("class_id", classId).order("student_id"),
    db.from("assessment_attempts")
      .select("id,student_id,status,started_at,finished_at,score,max_score,passed,elapsed_ms")
      .eq("assignment_id", assignmentId).order("started_at", { ascending: false }),
    db.from("assessment_questions")
      .select("id,question_type,prompt,choices,points,position")
      .eq("template_id", templateId).order("position"),
  ]);

  if (studentsResult.error || attemptsResult.error || questionsResult.error) return { ok: false };

  const attempts = attemptsResult.data ?? [];
  const completedIds = attempts.filter((attempt) => attempt.status === "completed").map((attempt) => attempt.id);
  let responses = [];
  if (completedIds.length) {
    const responseResult = await db.from("assessment_responses")
      .select("attempt_id,question_id,response,is_correct,awarded_points")
      .in("attempt_id", completedIds);
    if (responseResult.error) return { ok: false };
    responses = responseResult.data ?? [];
  }

  const students = (studentsResult.data ?? []).map((row) => {
    const profile = relationOne(row.profiles);
    return { id: row.student_id, name: profile?.full_name ?? "Учень" };
  });
  return { ok: true, data: { students, attempts, questions: questionsResult.data ?? [], responses } };
}

function newestFirst(left, right) {
  return new Date(right.started_at).getTime() - new Date(left.started_at).getTime();
}

export function summarizeAssignmentResults(data) {
  const responsesByAttempt = new Map();
  for (const response of data.responses) {
    const responses = responsesByAttempt.get(response.attempt_id) ?? [];
    responses.push(response);
    responsesByAttempt.set(response.attempt_id, responses);
  }

  const attemptsByStudent = new Map();
  for (const attempt of data.attempts) {
    const attempts = attemptsByStudent.get(attempt.student_id) ?? [];
    attempts.push(attempt);
    attemptsByStudent.set(attempt.student_id, attempts);
  }
  for (const attempts of attemptsByStudent.values()) attempts.sort(newestFirst);

  const rows = data.students.map((student) => {
    const attempts = attemptsByStudent.get(student.id) ?? [];
    const latestCompleted = attempts.find((attempt) => attempt.status === "completed") ?? null;
    const active = attempts.find((attempt) => attempt.status === "in_progress") ?? null;
    const latest = latestCompleted ?? active ?? attempts[0] ?? null;
    return {
      ...student,
      attempts,
      attemptCount: attempts.length,
      status: active ? "in_progress" : latestCompleted ? "completed" : latest ? "abandoned" : "not_started",
      latestCompleted,
      latest,
    };
  });

  const latestCompletedByStudent = rows.flatMap((row) => row.latestCompleted ? [row.latestCompleted] : []);
  const averagePercent = latestCompletedByStudent.length
    ? Math.round(latestCompletedByStudent.reduce((sum, attempt) => sum + (Number(attempt.max_score) > 0
      ? Number(attempt.score ?? 0) / Number(attempt.max_score) * 100 : 0), 0) / latestCompletedByStudent.length * 100) / 100
    : null;

  const responseByAttemptQuestion = new Map(data.responses.map((response) => [`${response.attempt_id}:${response.question_id}`, response]));
  const errorCounts = new Map();
  for (const attempt of latestCompletedByStudent) {
    for (const question of data.questions) {
      const response = responseByAttemptQuestion.get(`${attempt.id}:${question.id}`);
      if (!response || response.is_correct === false) {
        errorCounts.set(question.id, (errorCounts.get(question.id) ?? 0) + 1);
      }
    }
  }
  const mostCommonErrors = data.questions
    .filter((question) => (errorCounts.get(question.id) ?? 0) > 0)
    .map((question) => ({ question, count: errorCounts.get(question.id) }))
    .sort((left, right) => right.count - left.count || left.question.position - right.question.position);

  return {
    rows,
    completedStudentCount: latestCompletedByStudent.length,
    averagePercent,
    mostCommonErrors,
    responsesByAttempt,
  };
}

export function formatStudentAnswer(question, response) {
  if (!response) return "Немає відповіді";
  const choices = Array.isArray(question.choices) ? question.choices : [];
  const textById = new Map(choices.map((choice) => [choice.id, choice.text]));
  const resolve = (id) => textById.get(id) ?? "Варіант відповіді";
  const value = response.response;
  if (!value || typeof value !== "object") return "Відповідь збережено";
  switch (value.type) {
    case "true_false": return value.value === true ? "Так" : value.value === false ? "Ні" : "Відповідь збережено";
    case "single_choice": return resolve(value.choiceId);
    case "multiple_choice": return Array.isArray(value.choiceIds) ? value.choiceIds.map(resolve).join(", ") : "Відповідь збережено";
    case "ordering": return Array.isArray(value.order) ? value.order.map(resolve).join(" → ") : "Відповідь збережено";
    case "matching": return Array.isArray(value.pairs) ? value.pairs.map((pair) => `${resolve(pair.leftId)} — ${resolve(pair.rightId)}`).join("; ") : "Відповідь збережено";
    case "numeric":
    case "short_answer": return typeof value.text === "string" ? value.text : "Відповідь збережено";
    default: return "Відповідь збережено";
  }
}

export function promptText(prompt) {
  return prompt && typeof prompt === "object" && typeof prompt.text === "string" ? prompt.text : "Запитання";
}

export function formatElapsed(elapsedMs) {
  if (elapsedMs === null || elapsedMs === undefined || !Number.isFinite(Number(elapsedMs))) return "—";
  const totalSeconds = Math.max(0, Math.floor(Number(elapsedMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes} хв ${seconds} с` : `${seconds} с`;
}

export function statusLabel(status) {
  if (status === "in_progress") return "У процесі";
  if (status === "completed") return "Завершив(ла)";
  if (status === "abandoned") return "Спробу перервано";
  return "Не починав(ла)";
}

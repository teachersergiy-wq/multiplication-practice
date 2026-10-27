function relationOne(value) {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function questionPrompt(prompt) {
  return prompt && typeof prompt === "object" && typeof prompt.text === "string" ? prompt.text : "Запитання";
}

export async function loadAssignmentResults(client, { assignmentId, classId, templateId }) {
  const db = client;
  const [studentsResult, attemptsResult] = await Promise.all([
    db.from("class_students").select("student_id, profiles!inner(full_name)").eq("class_id", classId).order("student_id"),
    db.from("assessment_attempts")
      .select("id,student_id,status,started_at,finished_at,score,max_score,passed,elapsed_ms")
      .eq("assignment_id", assignmentId).order("started_at", { ascending: false }),
  ]);
  if (studentsResult.error || attemptsResult.error) return { ok: false };

  const attempts = attemptsResult.data ?? [];
  const attemptIds = attempts.map((attempt) => attempt.id);
  let sampleRows = [];
  if (attemptIds.length) {
    const sampleResult = await db.from("assessment_attempt_questions")
      .select("attempt_id,question_id,position")
      .in("attempt_id", attemptIds)
      .order("position", { ascending: true });
    if (sampleResult.error) return { ok: false };
    sampleRows = sampleResult.data ?? [];
  }

  const sampleQuestionIds = [...new Set(sampleRows.map((row) => row.question_id))];
  const hasAttemptWithoutSample = attempts.some((attempt) => !sampleRows.some((row) => row.attempt_id === attempt.id));
  let questionsResult;
  if (sampleQuestionIds.length) {
    questionsResult = await db.from("assessment_questions")
      .select("id,question_type,prompt,choices,points,position")
      .in("id", sampleQuestionIds)
      .order("position", { ascending: true });
    if (questionsResult.error) return { ok: false };
  }
  let templateQuestions = [];
  if (!sampleQuestionIds.length || hasAttemptWithoutSample) {
    const fallback = await db.from("assessment_questions")
      .select("id,question_type,prompt,choices,points,position")
      .eq("template_id", templateId)
      .order("position", { ascending: true });
    if (fallback.error) return { ok: false };
    templateQuestions = fallback.data ?? [];
  }

  const questionById = new Map([...(questionsResult?.data ?? []), ...templateQuestions].map((question) => [question.id, question]));
  const questionsByAttempt = new Map();
  for (const attempt of attempts) {
    const ordered = sampleRows.filter((row) => row.attempt_id === attempt.id).sort((left, right) => left.position - right.position);
    const sample = ordered.length ? ordered.map((row) => questionById.get(row.question_id)).filter(Boolean) : templateQuestions;
    questionsByAttempt.set(attempt.id, sample);
  }
  const questions = [...new Map([...questionsByAttempt.values()].flat().map((question) => [question.id, question])).values()];

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
  return { ok: true, data: { students, attempts, questions, questionsByAttempt, responses } };
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
  const questionById = new Map(data.questions.map((question) => [question.id, question]));
  for (const attempt of latestCompletedByStudent) {
    const attemptQuestions = data.questionsByAttempt?.get(attempt.id) ?? data.questions;
    for (const question of attemptQuestions) {
      const response = responseByAttemptQuestion.get(`${attempt.id}:${question.id}`);
      if (!response || response.is_correct === false) {
        const current = errorCounts.get(question.id) ?? { question, count: 0 };
        current.count += 1;
        errorCounts.set(question.id, current);
      }
    }
  }
  const mostCommonErrors = [...errorCounts.values()]
    .sort((left, right) => right.count - left.count || left.question.position - right.question.position);

  return {
    rows,
    completedStudentCount: latestCompletedByStudent.length,
    averagePercent,
    mostCommonErrors,
    responsesByAttempt,
    questionsByAttempt: data.questionsByAttempt ?? new Map(),
    questionById,
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
  return questionPrompt(prompt);
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

function timingSeconds(value) {
  if (value === null || value === undefined || value === "") return null;
  const seconds = typeof value === "number" ? value : Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

export function formatQuestionSeconds(value) {
  const seconds = timingSeconds(value);
  if (seconds === null) return "—";
  const rounded = Math.round((seconds + Number.EPSILON) * 10) / 10;
  return `${rounded.toLocaleString("uk-UA", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} с`;
}

export function prepareAttemptTiming(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const questions = (Array.isArray(value.questions) ? value.questions : [])
    .map((question, index) => ({
      questionId: typeof question?.questionId === "string" ? question.questionId : "",
      position: Number.isFinite(Number(question?.position)) ? Number(question.position) : index + 1,
      answerSeconds: timingSeconds(question?.answerSeconds),
      isCorrect: typeof question?.isCorrect === "boolean" ? question.isCorrect : null,
      originalIndex: index,
    }))
    .filter((question) => question.questionId.length > 0)
    .sort((left, right) => left.position - right.position || left.originalIndex - right.originalIndex)
    .map(({ originalIndex, ...question }) => question);

  const hasAnswers = questions.some((question) => question.answerSeconds !== null);
  const summary = value.summary && typeof value.summary === "object" ? value.summary : {};
  return {
    attemptId: typeof value.attemptId === "string" ? value.attemptId : "",
    questions,
    summary: {
      avgSeconds: hasAnswers ? timingSeconds(summary.avgSeconds) : null,
      medianSeconds: hasAnswers ? timingSeconds(summary.medianSeconds) : null,
      minSeconds: hasAnswers ? timingSeconds(summary.minSeconds) : null,
      maxSeconds: hasAnswers ? timingSeconds(summary.maxSeconds) : null,
    },
  };
}

export async function loadAttemptTiming(client, { teacherId, attemptId }) {
  if (!client || typeof client.rpc !== "function" || !teacherId || !attemptId) {
    return { ok: false, reason: "unavailable" };
  }

  try {
    const { data, error } = await client.rpc("api_teacher_attempt_timing", {
      p_teacher_id: teacherId,
      p_attempt_id: attemptId,
    });
    if (error) {
      const message = [error.message, error.details, error.hint].filter(Boolean).join(" ");
      return { ok: false, reason: /not_found/i.test(message) ? "not_found" : "unavailable" };
    }
    const prepared = prepareAttemptTiming(data);
    return prepared ? { ok: true, data: prepared } : { ok: false, reason: "unavailable" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: /not_found/i.test(message) ? "not_found" : "unavailable" };
  }
}

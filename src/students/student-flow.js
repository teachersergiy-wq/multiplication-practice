export const STUDENT_LOGIN_PATTERN = /^[a-hjkmnp-z]{4}$/;
export const STUDENT_PASSWORD_PATTERN = /^[a-hjkmnp-z]{2}[0-9]{4}$/;
export const STUDENT_AUTH_ERROR = "Не вдалося увійти. Перевірте логін і пароль та спробуйте ще раз.";

export function studentEmail(login, domain) {
  const normalizedLogin = String(login ?? "").trim().toLowerCase();
  const normalizedDomain = String(domain ?? "").trim().toLowerCase();
  if (!STUDENT_LOGIN_PATTERN.test(normalizedLogin) || !normalizedDomain || /[@/\s]/.test(normalizedDomain)) return null;
  return `${normalizedLogin}@${normalizedDomain}`;
}

export function studentAuthError() {
  return STUDENT_AUTH_ERROR;
}

export function responseForQuestion(question, value) {
  if (!question || typeof question !== "object") return null;
  switch (question.type) {
    case "true_false": return typeof value === "boolean" ? { type: "true_false", value } : null;
    case "single_choice": return question.choices.some((choice) => choice.id === value) ? { type: "single_choice", choiceId: value } : null;
    case "multiple_choice": return Array.isArray(value) && value.length > 0 && new Set(value).size === value.length && value.every((id) => question.choices.some((choice) => choice.id === id)) ? { type: "multiple_choice", choiceIds: value } : null;
    case "ordering": return Array.isArray(value) && value.length === question.choices.length && new Set(value).size === value.length && value.every((id) => question.choices.some((choice) => choice.id === id)) ? { type: "ordering", order: value } : null;
    case "matching": {
      const leftIds = question.items.filter((item) => item.side === "left").map((item) => item.id);
      const rightIds = question.items.filter((item) => item.side === "right").map((item) => item.id);
      const pairs = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray(value.pairs) ? value.pairs : null;
      return pairs && pairs.length === leftIds.length && pairs.every((pair) => pair && leftIds.includes(pair.leftId) && rightIds.includes(pair.rightId)) && new Set(pairs.map((pair) => pair.leftId)).size === leftIds.length && new Set(pairs.map((pair) => pair.rightId)).size === rightIds.length
        ? { type: "matching", pairs } : null;
    }
    case "numeric":
    case "short_answer": return typeof value === "string" && value.trim() ? { type: question.type, text: value } : null;
    default: return null;
  }
}

export function correctedNow(serverNow, receivedAt, deviceNow) {
  const serverMs = Date.parse(serverNow);
  if (!Number.isFinite(serverMs) || !Number.isFinite(receivedAt) || !Number.isFinite(deviceNow)) return deviceNow;
  return serverMs + (deviceNow - receivedAt);
}

export function remainingSeconds(deadlineAt, serverNow, receivedAt, deviceNow = Date.now()) {
  const deadlineMs = Date.parse(deadlineAt);
  if (!Number.isFinite(deadlineMs)) return null;
  const now = correctedNow(serverNow, receivedAt, deviceNow);
  return Math.max(0, Math.ceil((deadlineMs - now) / 1000));
}

export function assignmentWindow(opensAt, closesAt, nowMs = Date.now()) {
  if (opensAt && Date.parse(opensAt) > nowMs) return "upcoming";
  if (closesAt && Date.parse(closesAt) <= nowMs) return "closed";
  return "open";
}

const DRAFT_PREFIX = "student-attempt-draft:";

export function attemptStorage(storage = typeof localStorage !== "undefined" ? localStorage : null) {
  return storage;
}

export function readAttemptDraft(storage, attemptId) {
  if (!storage || !attemptId) return {};
  try {
    const raw = storage.getItem(DRAFT_PREFIX + attemptId);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeAttemptDraft(storage, attemptId, questionId, value) {
  if (!storage || !attemptId || !questionId) return false;
  try {
    const current = readAttemptDraft(storage, attemptId);
    current[questionId] = value;
    storage.setItem(DRAFT_PREFIX + attemptId, JSON.stringify(current));
    return true;
  } catch {
    return false;
  }
}

export function clearAttemptDraft(storage, attemptId, questionId) {
  if (!storage || !attemptId) return;
  try {
    if (!questionId) {
      storage.removeItem(DRAFT_PREFIX + attemptId);
      return;
    }
    const current = readAttemptDraft(storage, attemptId);
    delete current[questionId];
    if (Object.keys(current).length === 0) storage.removeItem(DRAFT_PREFIX + attemptId);
    else storage.setItem(DRAFT_PREFIX + attemptId, JSON.stringify(current));
  } catch {
    /* ignore */
  }
}

export function clearAllAttemptDrafts(storage) {
  if (!storage) return;
  try {
    const keys = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key && key.startsWith(DRAFT_PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function studentApiMessage(code) {
  const messages = {
    invalid_request: "Не вдалося зберегти відповідь. Перевірте її та спробуйте ще раз.",
    unauthenticated: "Сеанс завершився. Увійдіть знову.",
    forbidden: "Це завдання недоступне для вашого облікового запису.",
    not_found: "Завдання не знайдено. Оновіть список і спробуйте ще раз.",
    conflict: "Дію не можна виконати зараз. Оновіть список завдань.",
    incomplete_assessment: "Тест поки недоступний. Зверніться до вчителя.",
    assignment_not_open: "Завдання ще не відкрите.",
    assignment_closed: "Час виконання цього завдання завершився.",
    retry_not_allowed: "Повторна спроба для цього завдання недоступна.",
    attempt_not_in_progress: "Цю спробу вже завершено.",
    attempt_expired: "Час виконання завершився. Відкриваємо результат…",
    already_answered: "Відповідь уже збережено. Переходимо далі.",
    rate_limited: "Забагато запитів. Зачекайте трохи й повторіть.",
    internal: "Не вдалося зв’язатися із сервісом. Відповідь залишилася на пристрої — спробуйте ще раз.",
  };
  return messages[code] ?? messages.internal;
}

export function publicFeedback(mode, response) {
  if (mode !== "practice" || !response?.ok || !response.data?.accepted) return null;
  const feedback = response.data.feedback;
  return feedback && typeof feedback.isCorrect === "boolean" && Number.isFinite(feedback.awardedPoints)
    ? { isCorrect: feedback.isCorrect, awardedPoints: feedback.awardedPoints }
    : null;
}

/** Correct answers on the result screen: unanswered already count as mistakes. */
export function correctAnswerCount(questionCount, mistakes) {
  const total = Number(questionCount);
  const wrong = Number(mistakes);
  if (!Number.isFinite(total) || !Number.isFinite(wrong)) return 0;
  return Math.max(0, Math.round(total) - Math.max(0, Math.round(wrong)));
}

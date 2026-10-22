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
  return deviceNow + (serverMs - receivedAt);
}

export function remainingSeconds(deadlineAt, serverNow, receivedAt, deviceNow) {
  if (!deadlineAt) return null;
  const deadlineMs = Date.parse(deadlineAt);
  if (!Number.isFinite(deadlineMs)) return null;
  return Math.max(0, Math.ceil((deadlineMs - correctedNow(serverNow, receivedAt, deviceNow)) / 1000));
}

const draftKey = (attemptId) => `student-attempt-draft:${attemptId}`;
const unavailableStorage = {
  get length() { throw new Error("Session storage unavailable"); },
  key() { throw new Error("Session storage unavailable"); },
  getItem() { throw new Error("Session storage unavailable"); },
  setItem() { throw new Error("Session storage unavailable"); },
  removeItem() { throw new Error("Session storage unavailable"); },
};

export function attemptStorage() {
  try { return globalThis.sessionStorage; }
  catch { return unavailableStorage; }
}

export function readAttemptDraft(storage, attemptId) {
  try {
    const parsed = JSON.parse(storage.getItem(draftKey(attemptId)) ?? "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeAttemptDraft(storage, attemptId, questionId, response) {
  try {
    const draft = readAttemptDraft(storage, attemptId);
    draft[questionId] = response;
    storage.setItem(draftKey(attemptId), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearAttemptDraft(storage, attemptId, questionId) {
  try {
    const draft = readAttemptDraft(storage, attemptId);
    delete draft[questionId];
    if (Object.keys(draft).length) storage.setItem(draftKey(attemptId), JSON.stringify(draft));
    else storage.removeItem(draftKey(attemptId));
  } catch { /* session storage may be unavailable */ }
}

export function clearAllAttemptDrafts(storage) {
  try {
    for (let i = storage.length - 1; i >= 0; i--) {
      const key = storage.key(i);
      if (key?.startsWith("student-attempt-draft:")) storage.removeItem(key);
    }
  } catch { /* session storage may be unavailable */ }
}

export function assignmentWindow(opensAt, closesAt, now = Date.now()) {
  if (opensAt && Date.parse(opensAt) > now) return "upcoming";
  if (closesAt && Date.parse(closesAt) <= now) return "closed";
  return "open";
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

const SCOPE_LABELS = {
  class: "клас",
  school: "школа",
  school_year: "школа за навчальний рік",
  absolute: "загальний рейтинг паралелі",
};

export function competitiveNow(serverNow, receivedAt, deviceNow = Date.now()) {
  const serverMs = Date.parse(serverNow);
  if (!Number.isFinite(serverMs) || !Number.isFinite(receivedAt)) return deviceNow;
  return serverMs + (deviceNow - receivedAt);
}

export function competitiveRemainingSeconds(limitMs, serverNow, receivedAt, deviceNow = Date.now()) {
  if (!Number.isFinite(limitMs) || limitMs < 0) return null;
  return Math.max(0, Math.ceil((limitMs - (competitiveNow(serverNow, receivedAt, deviceNow) - Date.parse(serverNow))) / 1000));
}

export function formatCompetitiveDuration(durationMs) {
  const seconds = Math.max(0, Math.floor(Number(durationMs) / 1000));
  if (!Number.isFinite(seconds)) return "—";
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function qualifiedLabels(qualified = []) {
  return qualified.map(({ scope, rank }) => ({ scope, rank, label: SCOPE_LABELS[scope] ?? "рейтинг" }));
}

export function publishChoices(qualified = []) {
  if (!qualified.length) return ["none"];
  const choices = ["none", "nickname", "anonymous"];
  if (qualified.some(({ scope }) => scope === "class")) choices.push("name");
  return choices;
}

export function competitiveApiMessage(code) {
  const messages = {
    invalid_request: "Не вдалося надіслати відповідь. Перевір її та спробуй ще раз.",
    unauthenticated: "Сеанс завершився. Увійди знову.",
    forbidden: "Цей рівень ще закритий. Пройди попередній рівень.",
    not_found: "Тему або забіг не знайдено. Повертаємося до списку тем.",
    conflict: "Забіг уже завершено або денний ліміт запусків вичерпано.",
    rate_limited: "",
    internal: "Не вдалося зв’язатися із сервісом. Відповідь залишилася на екрані — спробуй ще раз.",
  };
  return messages[code] ?? messages.internal;
}

export function updateQuestionClock(previous, limitMs, receivedAt = Date.now()) {
  const now = competitiveNow(previous.serverNow, previous.receivedAt, receivedAt);
  return { serverNow: new Date(now).toISOString(), receivedAt, limitMs };
}

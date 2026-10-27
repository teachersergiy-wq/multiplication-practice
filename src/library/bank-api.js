export const DEFAULT_BANK_LEVEL_COUNTS = [5, 10, 10, 5, 0];

export function normalizeLevelCounts(values) {
  if (!Array.isArray(values) || values.length !== 5) return null;
  const counts = values.map(Number);
  if (!counts.every((value) => Number.isInteger(value) && value >= 0)) return null;
  const total = counts.reduce((sum, value) => sum + value, 0);
  return total >= 1 && total <= 100 ? counts : null;
}

export function buildBankRequest({ subjectId, gradeLevel, mode, title, levelCounts = DEFAULT_BANK_LEVEL_COUNTS }) {
  const counts = normalizeLevelCounts(levelCounts);
  if (!counts) throw new RangeError("levelCounts must contain five non-negative integers with a total from 1 to 100");
  const request = { subjectId, gradeLevel: Number(gradeLevel), mode, levelCounts: counts };
  const trimmedTitle = typeof title === "string" ? title.trim() : "";
  if (trimmedTitle) request.title = trimmedTitle;
  return request;
}

export function summarizeBank(bankByLevel, requiredByLevel) {
  const have = Array.from({ length: 5 }, (_, index) => Number(bankByLevel?.[index]) || 0);
  const need = Array.from({ length: 5 }, (_, index) => Number(requiredByLevel?.[index]) || 0);
  const missing = have.map((count, index) => Math.max(0, need[index] - count));
  return { have, need, missing, total: have.reduce((sum, value) => sum + value, 0), complete: missing.every((value) => value === 0) };
}

export function filterBankQuestions(questions, { level = "all", search = "", page = 1, pageSize = 25 } = {}) {
  const normalizedSearch = String(search).trim().toLocaleLowerCase("uk-UA");
  const filtered = (questions ?? []).filter((question) =>
    (level === "all" || Number(question.difficulty) === Number(level)) &&
    (!normalizedSearch || String(question.promptText ?? "").toLocaleLowerCase("uk-UA").includes(normalizedSearch))
  );
  const safePageSize = Math.max(1, Math.floor(Number(pageSize) || 25));
  const pageCount = Math.max(1, Math.ceil(filtered.length / safePageSize));
  const currentPage = Math.min(pageCount, Math.max(1, Math.floor(Number(page) || 1)));
  const start = (currentPage - 1) * safePageSize;
  return { items: filtered.slice(start, start + safePageSize), filteredCount: filtered.length, page: currentPage, pageCount };
}

export function buildBulkUpdateRequest(templateId, questionIds, action) {
  if (!Array.isArray(questionIds) || questionIds.length < 1 || questionIds.length > 500) {
    throw new RangeError("Select between 1 and 500 questions");
  }
  if (action?.delete === true) return { templateId, questionIds: [...questionIds], delete: true };
  const update = {};
  if (action?.difficulty !== undefined) update.difficulty = Number(action.difficulty);
  if (action?.points !== undefined) update.points = Number(action.points);
  if (action?.timeLimitSeconds !== undefined) update.timeLimitSeconds = action.timeLimitSeconds === null ? null : Number(action.timeLimitSeconds);
  if (!Object.keys(update).length) throw new TypeError("At least one update field is required");
  return { templateId, questionIds: [...questionIds], update };
}

export function bankErrorMessage(code) {
  if (code === "invalid_request") return "Перевірте назву, клас і кількість запитань. Загальна кількість має бути від 1 до 100.";
  if (code === "not_found") return "Не знайдено активний предмет або потрібні дані тесту.";
  if (code === "conflict") return "Досягнуто добовий ліміт створення тестів. Спробуйте пізніше.";
  if (code === "incomplete_assessment") return "У банку недостатньо запитань одного або кількох рівнів складності.";
  if (code === "forbidden") return "Немає доступу до цього тесту.";
  return null;
}

export function generateBank(request, callFunction) {
  return callFunction("generate-multiplication-bank", request);
}

export function bulkUpdateBank(request, callFunction) {
  return callFunction("bulk-update-questions", request);
}

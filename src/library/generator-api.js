export function buildGeneratorRequest({ subjectId, gradeLevel, levelNumber, mode, title }) {
  const request = { subjectId, gradeLevel: Number(gradeLevel), levelNumber: Number(levelNumber), mode };
  const trimmedTitle = typeof title === "string" ? title.trim() : "";
  if (trimmedTitle) request.title = trimmedTitle;
  return request;
}

export function selectApplicableConfig(rows, gradeLevel, levelNumber) {
  return (rows ?? [])
    .filter((row) => row.active !== false && Number(row.level_number) === Number(levelNumber) && Number(row.grade_level) <= Number(gradeLevel))
    .sort((left, right) => Number(right.grade_level) - Number(left.grade_level))[0] ?? null;
}

export function generatorErrorMessage(code) {
  if (code === "invalid_request") return "Перевірте клас, рівень множення та режим тесту.";
  if (code === "not_found") return "Не знайдено налаштувань для цього класу й рівня. Оберіть інший клас або рівень.";
  if (code === "conflict") return "Досягнуто добовий ліміт створення тестів. Спробуйте завтра.";
  return null;
}

export function generateTest(request, callFunction) {
  return callFunction("generate-multiplication-test", request);
}

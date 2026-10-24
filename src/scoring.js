const PARTIAL_CREDIT_HINTS = {
  multiple_choice: "За правильні вибори нараховуються бали, за зайві — віднімаються.",
  ordering: "Бали нараховуються за кожні правильні сусідні елементи в порядку.",
  matching: "Бали нараховуються за кожну правильно знайдену пару.",
};

export function formatScore(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return number.toFixed(2).replace(/\.?0+$/, "");
}

export function partialCreditHint(questionType) {
  return PARTIAL_CREDIT_HINTS[questionType] ?? "";
}

export function practiceFeedbackText(feedback, maxPoints) {
  const awarded = Number(feedback?.awardedPoints);
  if (!Number.isFinite(awarded)) return "Відповідь збережено.";
  const awardedText = formatScore(awarded);
  const maxText = formatScore(maxPoints);
  if (feedback.isCorrect) return `Правильно! · ${awardedText} з ${maxText} балів.`;
  if (awarded > 0) return `Частково: ${awardedText} з ${maxText} балів.`;
  return "Поки не вийшло. Наступне запитання допоможе потренуватися.";
}

export function teacherQuestionScoreLabel(isCorrect, awardedPoints, maxPoints) {
  const awarded = Number(awardedPoints ?? 0);
  const max = Number(maxPoints);
  const score = `${formatScore(awarded)} з ${formatScore(max)} балів`;
  if (isCorrect === true) return `Правильно · ${score}`;
  if (awarded > 0) return `Частково · ${score}`;
  return `Неправильно · ${score}`;
}

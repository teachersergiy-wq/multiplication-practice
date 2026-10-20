
import { LIMITS } from "../contracts/api.ts";
import type { AuthoredQuestion, QuestionType } from "../contracts/api.ts";

const QUESTION_TYPES: QuestionType[] = ["true_false", "single_choice", "multiple_choice", "ordering", "matching", "numeric", "short_answer"];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const textList = (value: unknown, min: number, max: number, maxLength: number): value is string[] =>
  Array.isArray(value) && value.length >= min && value.length <= max && value.every((item) => typeof item === "string" && item.trim().length >= 1 && item.length <= maxLength);

export function validateAuthoredQuestion(value: unknown): string[] {
  if (!isRecord(value)) return ["Запитання має бути коректно заповнене."];
  const errors: string[] = [];
  if (!QUESTION_TYPES.includes(value.type as QuestionType)) return ["Оберіть тип запитання."];
  if (typeof value.promptText !== "string" || value.promptText.trim().length < LIMITS.promptText.min || value.promptText.length > LIMITS.promptText.max) errors.push(`Текст запитання: ${LIMITS.promptText.min}–${LIMITS.promptText.max} символів.`);
  if (typeof value.points !== "number" || !Number.isFinite(value.points) || value.points < LIMITS.points.min || value.points > LIMITS.points.max) errors.push(`Балів має бути від ${LIMITS.points.min} до ${LIMITS.points.max}.`);
  if (value.timeLimitSeconds !== undefined && value.timeLimitSeconds !== null && (!Number.isInteger(value.timeLimitSeconds) || (value.timeLimitSeconds as number) < LIMITS.timeLimitSeconds.min || (value.timeLimitSeconds as number) > LIMITS.timeLimitSeconds.max)) errors.push(`Час має бути від ${LIMITS.timeLimitSeconds.min} до ${LIMITS.timeLimitSeconds.max} секунд.`);

  if (value.type === "true_false") {
    if (typeof value.correct !== "boolean") errors.push("Оберіть правильну відповідь.");
  } else if (value.type === "single_choice" || value.type === "multiple_choice") {
    const bounds = value.type === "single_choice" ? LIMITS.singleChoiceOptions : LIMITS.multipleChoiceOptions;
    if (!textList(value.options, bounds.min, bounds.max, LIMITS.optionText.max)) errors.push(`Додайте ${bounds.min}–${bounds.max} варіантів, кожен до ${LIMITS.optionText.max} символів.`);
    const optionCount = Array.isArray(value.options) ? value.options.length : 0;
    if (value.type === "single_choice") {
      if (!Number.isInteger(value.correctIndex) || (value.correctIndex as number) < 0 || (value.correctIndex as number) >= optionCount) errors.push("Позначте один правильний варіант.");
    } else if (!Array.isArray(value.correctIndexes) || value.correctIndexes.length < 1 || value.correctIndexes.some((index) => !Number.isInteger(index) || (index as number) < 0 || (index as number) >= optionCount) || new Set(value.correctIndexes).size !== value.correctIndexes.length) errors.push("Позначте щонайменше один правильний варіант.");
  } else if (value.type === "ordering") {
    if (!textList(value.itemsInCorrectOrder, LIMITS.orderingItems.min, LIMITS.orderingItems.max, LIMITS.optionText.max)) errors.push(`Додайте ${LIMITS.orderingItems.min}–${LIMITS.orderingItems.max} елементів у правильному порядку.`);
  } else if (value.type === "matching") {
    const pairs = value.pairs;
    if (!Array.isArray(pairs) || pairs.length < LIMITS.matchingPairs.min || pairs.length > LIMITS.matchingPairs.max || !pairs.every((pair) => isRecord(pair) && typeof pair.left === "string" && pair.left.trim().length > 0 && pair.left.length <= LIMITS.optionText.max && typeof pair.right === "string" && pair.right.trim().length > 0 && pair.right.length <= LIMITS.optionText.max)) errors.push(`Додайте ${LIMITS.matchingPairs.min}–${LIMITS.matchingPairs.max} пар зі значеннями до ${LIMITS.optionText.max} символів.`);
  } else if (value.type === "numeric") {
    if (typeof value.value !== "number" || !Number.isFinite(value.value)) errors.push("Введіть правильну числову відповідь.");
    if (value.tolerance !== undefined && (typeof value.tolerance !== "number" || !Number.isFinite(value.tolerance) || value.tolerance < 0)) errors.push("Допуск має бути невід’ємним числом.");
  } else if (value.type === "short_answer") {
    if (!textList(value.accepted, LIMITS.shortAnswerAccepted.min, LIMITS.shortAnswerAccepted.max, LIMITS.shortAnswerLength.max)) errors.push(`Додайте ${LIMITS.shortAnswerAccepted.min}–${LIMITS.shortAnswerAccepted.max} відповідей, кожна до ${LIMITS.shortAnswerLength.max} символів.`);
    if (value.caseSensitive !== undefined && typeof value.caseSensitive !== "boolean") errors.push("Перевірте налаштування великих і малих літер.");
  }
  return errors;
}

export function isAuthoredQuestion(value: unknown): value is AuthoredQuestion {
  return validateAuthoredQuestion(value).length === 0;
}


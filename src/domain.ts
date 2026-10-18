export type QuestionType =
  | "numeric"
  | "short_answer"
  | "single_choice"
  | "multiple_choice"
  | "true_false";

export const questionTypeLabels: Record<QuestionType, string> = {
  numeric: "Числова відповідь",
  short_answer: "Коротка відповідь",
  single_choice: "Один варіант відповіді",
  multiple_choice: "Кілька варіантів відповіді",
  true_false: "Так або ні",
};

export interface Subject {
  code: string;
  name: string;
  icon: string;
  tone: string;
  description: string;
}

export interface AssessmentDraft {
  id: string;
  title: string;
  /** The subject's stable `code`; the property name stays for stored draft compatibility. */
  subjectId: string;
  grade: number;
  questionType: QuestionType;
  questionCount: number;
  durationMinutes: number;
  updatedAt: string;
}

const legacySubjectCodes: Record<string, string> = {
  math: "mathematics",
  ukrainian: "ukrainian-language",
  english: "english-language",
};

export function migrateAssessmentDrafts(value: unknown): AssessmentDraft[] | null {
  if (!Array.isArray(value)) return null;

  return value.map((draft: AssessmentDraft) => ({
    ...draft,
    subjectId: legacySubjectCodes[draft.subjectId] ?? draft.subjectId,
  }));
}

export const subjects: Subject[] = [
  { code: "mathematics", name: "Математика", icon: "＋", tone: "lilac", description: "Множення, дроби, задачі" },
  { code: "ukrainian-language", name: "Українська мова", icon: "А", tone: "peach", description: "Мова, читання, правопис" },
  { code: "english-language", name: "Англійська мова", icon: "Aa", tone: "blue", description: "Слова, граматика, читання" },
  { code: "science", name: "Я досліджую світ", icon: "✳", tone: "mint", description: "Природа, людина, суспільство" },
];

// The UI currently supports grades 1–11; the database allows grades through 12.
export const grades = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

export const starterDrafts: AssessmentDraft[] = [
  { id: "multiplication-level-1", title: "Таблиця множення · рівень 1", subjectId: "mathematics", grade: 3, questionType: "numeric", questionCount: 10, durationMinutes: 3, updatedAt: "Приклад шаблону" },
  { id: "fractions-intro", title: "Знайомство з дробами", subjectId: "mathematics", grade: 5, questionType: "single_choice", questionCount: 8, durationMinutes: 10, updatedAt: "Приклад шаблону" },
  { id: "ukrainian-vowels", title: "Голосні та приголосні", subjectId: "ukrainian-language", grade: 2, questionType: "single_choice", questionCount: 10, durationMinutes: 8, updatedAt: "Приклад шаблону" },
];

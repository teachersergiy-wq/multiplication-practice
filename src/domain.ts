export type QuestionType = "multiple_choice" | "short_answer" | "numeric";

export interface Subject {
  id: string;
  name: string;
  icon: string;
  tone: string;
  description: string;
}

export interface AssessmentDraft {
  id: string;
  title: string;
  subjectId: string;
  grade: number;
  questionType: QuestionType;
  questionCount: number;
  durationMinutes: number;
  updatedAt: string;
}

export const subjects: Subject[] = [
  { id: "math", name: "Математика", icon: "＋", tone: "lilac", description: "Множення, дроби, задачі" },
  { id: "ukrainian", name: "Українська мова", icon: "А", tone: "peach", description: "Мова, читання, правопис" },
  { id: "english", name: "Англійська мова", icon: "Aa", tone: "blue", description: "Слова, граматика, читання" },
  { id: "science", name: "Я досліджую світ", icon: "✳", tone: "mint", description: "Природа, людина, суспільство" },
];

export const grades = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

export const starterDrafts: AssessmentDraft[] = [
  { id: "multiplication-level-1", title: "Таблиця множення · рівень 1", subjectId: "math", grade: 3, questionType: "numeric", questionCount: 10, durationMinutes: 3, updatedAt: "Приклад шаблону" },
  { id: "fractions-intro", title: "Знайомство з дробами", subjectId: "math", grade: 5, questionType: "multiple_choice", questionCount: 8, durationMinutes: 10, updatedAt: "Приклад шаблону" },
  { id: "ukrainian-vowels", title: "Голосні та приголосні", subjectId: "ukrainian", grade: 2, questionType: "multiple_choice", questionCount: 10, durationMinutes: 8, updatedAt: "Приклад шаблону" },
];

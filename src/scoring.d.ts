export function formatScore(value: number | string | null | undefined): string;
export function partialCreditHint(questionType: string): string;
export function practiceFeedbackText(feedback: { isCorrect: boolean; awardedPoints: number }, maxPoints: number): string;
export function teacherQuestionScoreLabel(isCorrect: boolean | null, awardedPoints: number | string | null, maxPoints: number | string): string;

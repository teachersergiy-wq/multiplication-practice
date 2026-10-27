import type { AnswerResponse, PublicQuestion } from "../../contracts/api";

export const STUDENT_LOGIN_PATTERN: RegExp;
export const STUDENT_PASSWORD_PATTERN: RegExp;
export const STUDENT_AUTH_ERROR: string;
export function studentEmail(login: unknown, domain: unknown): string | null;
export function studentAuthError(): string;
export function responseForQuestion(question: PublicQuestion, value: unknown): AnswerResponse | null;
export function correctedNow(serverNow: string, receivedAt: number, deviceNow: number): number;
export function remainingSeconds(deadlineAt: string | null, serverNow: string, receivedAt: number, deviceNow: number): number | null;
export function readAttemptDraft(storage: Storage, attemptId: string): Record<string, unknown>;
export function writeAttemptDraft(storage: Storage, attemptId: string, questionId: string, response: unknown): boolean;
export function clearAttemptDraft(storage: Storage, attemptId: string, questionId: string): void;
export function clearAllAttemptDrafts(storage: Storage): void;
export function assignmentWindow(opensAt: string | null, closesAt: string | null, now?: number): "open" | "upcoming" | "closed";
export function studentApiMessage(code: string): string;
export function publicFeedback(mode: string, response: unknown): { isCorrect: boolean; awardedPoints: number } | null;
export function attemptStorage(): Storage;
export function correctAnswerCount(questionCount: unknown, mistakes: unknown): number;

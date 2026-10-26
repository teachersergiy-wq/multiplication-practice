import type { AddTeacherRequest } from "../../contracts/api";

export function buildAddTeacherRequest(values: { email: string; fullName: string }): AddTeacherRequest;
export function buildResetTeacherPasswordRequest(userId: string): { userId: string };
export function buildSetTeacherActiveRequest(userId: string, active: boolean): { userId: string; active: boolean };
export function teacherAdminErrorMessage(code: string): string | null;
export function createTemporaryPasswordSlot(): {
  set(value: string): void;
  read(): string | null;
  clear(): void;
};

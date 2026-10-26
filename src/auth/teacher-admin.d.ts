import type { AddTeacherRequest } from "../../contracts/api";

export function buildAddTeacherRequest(values: { email: string; fullName: string }): AddTeacherRequest;
export function teacherAdminErrorMessage(code: string): string | null;
export function createTemporaryPasswordSlot(): {
  set(value: string): void;
  read(): string | null;
  clear(): void;
};

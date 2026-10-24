import type { ErrorCode } from "../../contracts/api";
import type { ApiResult, CreateClassData, CreateClassRequest, SetClassSubjectData, SetClassSubjectRequest } from "../../contracts/api";

export function validateClassInput(
  name: unknown,
  gradeLevel: unknown,
  subjectId: unknown,
):
  | { ok: true; name: string; gradeLevel: number; subjectId: string }
  | { ok: false; reason: "name" | "grade" | "subject" };

export function classFunctionMessage(code: ErrorCode, action: "create" | "configure"): string;
export function classSelectionAfterRefresh<T extends { id: string }>(rows: T[], currentId: string, preferredId?: string): string;
export function assignmentNoCompatibleClassMessage(gradeLevel: number, subjectName: string): string;
export function assignmentClassAvailability(compatibleClassCount: number, availableClassCount: number): "available" | "already-assigned" | "none-compatible";
export function buildClassRequest(mode: "create", values: CreateClassRequest): { name: "create-class"; body: CreateClassRequest };
export function buildClassRequest(mode: "configure", values: SetClassSubjectRequest): { name: "set-class-subject"; body: SetClassSubjectRequest };
export function saveClass(
  mode: "create",
  values: CreateClassRequest,
  invoke: (name: "create-class", body: CreateClassRequest) => Promise<ApiResult<CreateClassData>>,
): Promise<ApiResult<CreateClassData>>;
export function saveClass(
  mode: "configure",
  values: SetClassSubjectRequest,
  invoke: (name: "set-class-subject", body: SetClassSubjectRequest) => Promise<ApiResult<SetClassSubjectData>>,
): Promise<ApiResult<SetClassSubjectData>>;
export const CLASS_LIST_CHANGED_EVENT: string;
export function announceClassListChanged(): void;

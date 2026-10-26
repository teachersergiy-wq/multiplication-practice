import type { ApiResult, FunctionContracts } from "../../contracts/api";

export const DEFAULT_BANK_LEVEL_COUNTS: [number, number, number, number, number];
export function normalizeLevelCounts(values: unknown): [number, number, number, number, number] | null;
export function buildBankRequest(values: {
  subjectId: string;
  gradeLevel: number | string;
  mode: FunctionContracts["generate-multiplication-bank"]["request"]["mode"];
  title?: string;
  levelCounts?: number[];
}): FunctionContracts["generate-multiplication-bank"]["request"];
export function summarizeBank(bankByLevel: number[] | null | undefined, requiredByLevel: number[] | null | undefined): {
  have: number[]; need: number[]; missing: number[]; total: number; complete: boolean;
};
export interface BankQuestionRow {
  id: string;
  position: number;
  promptText: string;
  difficulty: number | null;
  points: number;
  timeLimitSeconds: number | null;
}
export function filterBankQuestions<T extends BankQuestionRow>(
  questions: T[],
  options?: { level?: number | "all"; search?: string; page?: number; pageSize?: number },
): { items: T[]; filteredCount: number; page: number; pageCount: number };
export function buildBulkUpdateRequest(
  templateId: string,
  questionIds: string[],
  action: { difficulty?: 1 | 2 | 3 | 4 | 5; points?: number; timeLimitSeconds?: number | null; delete?: boolean },
): FunctionContracts["bulk-update-questions"]["request"];
export function bankErrorMessage(code: string): string | null;
export function generateBank(
  request: FunctionContracts["generate-multiplication-bank"]["request"],
  callFunction: (name: "generate-multiplication-bank", body: FunctionContracts["generate-multiplication-bank"]["request"]) => Promise<ApiResult<FunctionContracts["generate-multiplication-bank"]["data"]>>,
): Promise<ApiResult<FunctionContracts["generate-multiplication-bank"]["data"]>>;
export function bulkUpdateBank(
  request: FunctionContracts["bulk-update-questions"]["request"],
  callFunction: (name: "bulk-update-questions", body: FunctionContracts["bulk-update-questions"]["request"]) => Promise<ApiResult<FunctionContracts["bulk-update-questions"]["data"]>>,
): Promise<ApiResult<FunctionContracts["bulk-update-questions"]["data"]>>;

import type { ApiResult, FunctionContracts } from "../../contracts/api";

export type GenerateRequest = FunctionContracts["generate-multiplication-test"]["request"];
export type GenerateData = FunctionContracts["generate-multiplication-test"]["data"];
export interface ConfigRow {
  grade_level: number;
  level_number: number;
  question_count: number;
  seconds_per_question: number;
  max_errors: number;
  pass_percent: number;
  min_factor: number;
  max_factor: number;
  active?: boolean;
}

export function buildGeneratorRequest(values: {
  subjectId: string;
  gradeLevel: number | string;
  levelNumber: number | string;
  mode: GenerateRequest["mode"];
  title?: string;
}): GenerateRequest;
export function selectApplicableConfig(rows: ConfigRow[] | null | undefined, gradeLevel: number, levelNumber: number): ConfigRow | null;
export function generatorErrorMessage(code: string): string | null;
export function generateTest(
  request: GenerateRequest,
  callFunction: (name: "generate-multiplication-test", body: GenerateRequest) => Promise<ApiResult<GenerateData>>,
): Promise<ApiResult<GenerateData>>;

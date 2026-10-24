export interface TeacherResultStudent {
  id: string;
  name: string;
}

export interface TeacherResultAttempt {
  id: string;
  student_id: string;
  status: "in_progress" | "completed" | "abandoned" | string;
  started_at: string;
  finished_at: string | null;
  score: number | string | null;
  max_score: number | string | null;
  passed: boolean | null;
  elapsed_ms: number | null;
}

export interface TeacherResultQuestion {
  id: string;
  question_type: string;
  prompt: unknown;
  choices: unknown;
  points: number | string;
  position: number;
}

export interface TeacherResultResponse {
  attempt_id: string;
  question_id: string;
  response: unknown;
  is_correct: boolean | null;
  awarded_points: number | string | null;
}

export interface AssignmentResultData {
  students: TeacherResultStudent[];
  attempts: TeacherResultAttempt[];
  questions: TeacherResultQuestion[];
  responses: TeacherResultResponse[];
}

export function loadAssignmentResults(client: unknown, request: { assignmentId: string; classId: string; templateId: string }): Promise<{ ok: true; data: AssignmentResultData } | { ok: false }>;
export function summarizeAssignmentResults(data: AssignmentResultData): {
  rows: Array<TeacherResultStudent & { attempts: TeacherResultAttempt[]; attemptCount: number; status: string; latestCompleted: TeacherResultAttempt | null; latest: TeacherResultAttempt | null }>;
  completedStudentCount: number;
  averagePercent: number | null;
  mostCommonErrors: Array<{ question: TeacherResultQuestion; count: number }>;
  responsesByAttempt: Map<string, TeacherResultResponse[]>;
};
export function formatStudentAnswer(question: TeacherResultQuestion, response: TeacherResultResponse | null | undefined): string;
export function promptText(prompt: unknown): string;
export function formatElapsed(elapsedMs: number | null | undefined): string;
export function statusLabel(status: string): string;

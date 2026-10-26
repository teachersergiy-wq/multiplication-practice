/**
 * API contract v1 between the web app (src/**), Edge Functions (supabase/functions/**)
 * and the database (supabase/migrations/**).
 *
 * Owner: coordinator. A change needs a PR that both the frontend and the server
 * executor have confirmed. Human-readable rules: docs/API_CONTRACT.md.
 *
 * This file holds types and constants only: no logic, no imports, no secrets.
 * Status: PLANNED. Nothing described here is implemented yet.
 */

export const CONTRACT_VERSION = 1;

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

export type Uuid = string;
/** UTC ISO 8601, e.g. "2026-10-18T07:30:00.000Z". The server clock is authoritative. */
export type IsoDateTime = string;

/* ------------------------------------------------------------------ */
/* Limits and credential format (single source of truth)               */
/* ------------------------------------------------------------------ */

export const LIMITS = {
  fullName: { min: 1, max: 160 },
  schoolName: { max: 160 },
  className: { max: 80 },
  promptText: { min: 1, max: 1000 },
  optionText: { min: 1, max: 200 },
  singleChoiceOptions: { min: 4, max: 5 },
  multipleChoiceOptions: { min: 3, max: 8 },
  orderingItems: { min: 3, max: 8 },
  matchingPairs: { min: 2, max: 8 },
  shortAnswerAccepted: { min: 1, max: 10 },
  shortAnswerLength: { max: 200 },
  points: { min: 0.01, max: 100 },
  timeLimitSeconds: { min: 1, max: 3600 },
  questionsPerTemplate: { max: 100 },
  studentsPerCreateCall: { min: 1, max: 40 },
  studentsPerClass: { max: 200 },
  /** Added to the computed attempt deadline to absorb network delay. */
  deadlineGraceSeconds: 15,
} as const;

/**
 * Student credentials (decision D1, variant B).
 * Alphabet: a-z without i, l, o (they are easy to confuse with 1 and 0).
 * Login: 3-4 letters; the server always generates 4. Password: 2 letters + 4 digits,
 * about 5.29 million combinations. Input is trimmed and lower-cased before checking.
 */
export const CREDENTIALS = {
  alphabet: "abcdefghjkmnpqrstuvwxyz",
  generatedLoginLength: 4,
  loginPattern: /^[a-hjkmnp-z]{3,4}$/,
  passwordPattern: /^[a-hjkmnp-z]{2}[0-9]{4}$/,
  /** Auth identity is "<login>@<STUDENT_EMAIL_DOMAIN>"; the domain is configuration, not a secret. */
  emailDomainEnvName: "STUDENT_EMAIL_DOMAIN",
} as const;

/* ------------------------------------------------------------------ */
/* Enumerations (mirror the database)                                  */
/* ------------------------------------------------------------------ */

export type QuestionType =
  | "true_false"
  | "single_choice"
  | "multiple_choice"
  | "ordering"
  | "matching"
  | "numeric"
  | "short_answer";

export type AssessmentMode = "practice" | "graded";
export type AssessmentStatus = "draft" | "published" | "archived";
export type AttemptStatus = "in_progress" | "completed" | "abandoned";

/** Stored in assessment_templates.settings. All fields optional. */
export interface AssessmentSettings {
  /** 1-100. Attempt passes only if percent >= passPercent (when set). */
  passPercent?: number;
  /** Attempt passes only if mistakes <= maxErrors (when set). Unanswered questions count as mistakes. */
  maxErrors?: number;
  /** Overall time limit. When absent, the sum of question limits is used if every question has one. */
  totalTimeSeconds?: number;
}

/* ------------------------------------------------------------------ */
/* Envelope and errors                                                 */
/* ------------------------------------------------------------------ */

export type ErrorCode =
  | "invalid_request"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "incomplete_assessment"
  | "assignment_not_open"
  | "assignment_closed"
  | "retry_not_allowed"
  | "attempt_not_in_progress"
  | "attempt_expired"
  | "already_answered"
  | "rate_limited"
  | "internal";

export interface ApiErrorBody {
  code: ErrorCode;
  /** Short English text for logs. The UI shows its own Ukrainian text chosen by `code`. */
  message: string;
  /** Never contains answer keys, passwords or tokens. */
  details?: Record<string, unknown>;
}

export interface ApiOk<T> {
  ok: true;
  data: T;
}
export interface ApiFail {
  ok: false;
  error: ApiErrorBody;
}
export type ApiResult<T> = ApiOk<T> | ApiFail;

export const HTTP_STATUS_BY_ERROR: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  incomplete_assessment: 409,
  assignment_not_open: 409,
  assignment_closed: 409,
  retry_not_allowed: 409,
  attempt_not_in_progress: 409,
  attempt_expired: 409,
  already_answered: 409,
  rate_limited: 429,
  internal: 500,
};

/* ------------------------------------------------------------------ */
/* Teacher provisioning                                                */
/* ------------------------------------------------------------------ */

export interface ProvisionTeacherRequest {
  /** Required when the profile does not exist yet; ignored otherwise. */
  fullName: string;
  schoolName?: string;
  className?: string;
}
export interface ProvisionTeacherData {
  profileId: Uuid;
  schoolId: Uuid;
  classId: Uuid;
  /** false when the profile already existed (the call is idempotent). */
  created: boolean;
}

/* ------------------------------------------------------------------ */
/* Students (teacher only)                                             */
/* ------------------------------------------------------------------ */

export interface CreateStudentsRequest {
  classId: Uuid;
  students: { fullName: string }[];
}
export interface CreatedStudent {
  studentId: Uuid;
  fullName: string;
  login: string;
  /** Returned once. Never stored in plain text, never logged, never returned again. */
  password: string;
}
export interface CreateStudentsData {
  students: CreatedStudent[];
}

export interface ResetStudentPasswordRequest {
  studentId: Uuid;
}
export interface ResetStudentPasswordData {
  studentId: Uuid;
  login: string;
  /** Returned once, same rules as at creation. */
  password: string;
}

export interface DeleteStudentRequest {
  studentId: Uuid;
}
export interface DeleteStudentData {
  deleted: true;
}

/* ------------------------------------------------------------------ */
/* Questions: authoring format (teacher <-> server)                    */
/* ------------------------------------------------------------------ */

interface AuthoredBase {
  promptText: string;
  points: number;
  timeLimitSeconds?: number | null;
}

/**
 * What the teacher sends. Indexes refer to positions in the arrays of the same object.
 * The server assigns opaque ids, shuffles where required and splits the data into the
 * public question row and the private answer key.
 */
export type AuthoredQuestion = AuthoredBase &
  (
    | { type: "true_false"; correct: boolean }
    | { type: "single_choice"; options: string[]; correctIndex: number }
    | { type: "multiple_choice"; options: string[]; correctIndexes: number[] }
    | { type: "ordering"; itemsInCorrectOrder: string[] }
    | { type: "matching"; pairs: { left: string; right: string }[] }
    | { type: "numeric"; value: number; tolerance?: number }
    | { type: "short_answer"; accepted: string[]; caseSensitive?: boolean }
  );

export type StoredAuthoredQuestion = AuthoredQuestion & {
  id: Uuid;
  position: number;
};

export interface AssessmentSummary {
  id: Uuid;
  title: string;
  subjectId: Uuid;
  gradeLevel: number;
  mode: AssessmentMode;
  status: AssessmentStatus;
  settings: AssessmentSettings;
}

export interface GetAssessmentDraftRequest {
  templateId: Uuid;
}
/** Teacher-only readback including correct answers (the only way to read answer keys). */
export interface GetAssessmentDraftData {
  template: AssessmentSummary;
  questions: StoredAuthoredQuestion[];
}

export interface UpsertQuestionRequest {
  templateId: Uuid;
  /** Omit to append a new question; set to replace an existing draft question. */
  questionId?: Uuid;
  question: AuthoredQuestion;
}
export interface UpsertQuestionData {
  questionId: Uuid;
}

export interface DeleteQuestionRequest {
  questionId: Uuid;
}
export interface DeleteQuestionData {
  deleted: true;
}

export interface ReorderQuestionsRequest {
  templateId: Uuid;
  /** Must contain every question of the template exactly once. */
  orderedQuestionIds: Uuid[];
}
export interface ReorderQuestionsData {
  reordered: true;
}

export interface PublishAssessmentRequest {
  templateId: Uuid;
}
export interface PublishAssessmentData {
  templateId: Uuid;
  status: "published";
  questionCount: number;
  totalPoints: number;
}

/** Published tests are immutable; to change one, clone it into a new draft. */
export interface CloneAssessmentRequest {
  templateId: Uuid;
}
export interface CloneAssessmentData {
  templateId: Uuid;
}

/* ------------------------------------------------------------------ */
/* Questions: public format (server -> student) and responses          */
/* ------------------------------------------------------------------ */

export interface PublicChoice {
  /** Opaque id. Carries no information about correctness or position. */
  id: string;
  text: string;
}
export interface PublicMatchItem {
  id: string;
  side: "left" | "right";
  text: string;
}

interface PublicBase {
  id: Uuid;
  position: number;
  promptText: string;
  points: number;
  timeLimitSeconds: number | null;
}

/** Never contains correctness data. For ordering, `choices` is a fixed scrambled order. */
export type PublicQuestion = PublicBase &
  (
    | { type: "true_false" }
    | { type: "single_choice" | "multiple_choice" | "ordering"; choices: PublicChoice[] }
    | { type: "matching"; items: PublicMatchItem[] }
    | { type: "numeric" | "short_answer" }
  );

/** What the student sends. `type` must equal the question's type. */
export type AnswerResponse =
  | { type: "true_false"; value: boolean }
  | { type: "single_choice"; choiceId: string }
  | { type: "multiple_choice"; choiceIds: string[] }
  | { type: "ordering"; order: string[] }
  | { type: "matching"; pairs: { leftId: string; rightId: string }[] }
  | { type: "numeric"; text: string }
  | { type: "short_answer"; text: string };

/* ------------------------------------------------------------------ */
/* Classes (teacher)                                                   */
/* ------------------------------------------------------------------ */

/** Creates a class in the teacher's school with one subject and grade level. */
export interface CreateClassRequest {
  /** 1–80 characters after trim; unique within the school. */
  name: string;
  subjectId: Uuid;
  /** Integer 1–12. */
  gradeLevel: number;
}
export interface CreateClassData {
  classId: Uuid;
  schoolId: Uuid;
  name: string;
  subjectId: Uuid;
  gradeLevel: number;
}

/**
 * Adds a subject + grade to an owned class (idempotent for the same grade).
 * Changing the grade of an existing subject is rejected with `conflict`
 * when assignments for that subject exist on the class.
 */
export interface SetClassSubjectRequest {
  classId: Uuid;
  subjectId: Uuid;
  gradeLevel: number;
}
export interface SetClassSubjectData {
  classId: Uuid;
  subjectId: Uuid;
  gradeLevel: number;
  /** true when a new class_subjects row was inserted. */
  created: boolean;
}

/* ------------------------------------------------------------------ */
/* Multiplication generator (teacher)                                  */
/* ------------------------------------------------------------------ */

/** Public row of multiplication_level_configs (read by teachers under RLS). */
export interface MultiplicationLevelConfig {
  gradeLevel: number;
  /** 1-5. */
  levelNumber: number;
  questionCount: number;
  secondsPerQuestion: number;
  maxErrors: number;
  passPercent: number;
  minFactor: number;
  maxFactor: number;
}

/**
 * Creates a new `draft` template of numeric questions "a × b = ?" from the
 * shared level config. The teacher can edit the draft and must publish it
 * through `publish-assessment` (decision D3).
 */
export interface GenerateMultiplicationTestRequest {
  /** Active subject with code `mathematics`. */
  subjectId: Uuid;
  /** Integer 1-11 (decision D8); selects the config row. */
  gradeLevel: number;
  /** Integer 1-5. */
  levelNumber: number;
  mode: AssessmentMode;
  /** Optional, 1-120 characters; default "Множення: рівень N". */
  title?: string;
}
export interface GenerateMultiplicationTestData {
  templateId: Uuid;
  title: string;
  questionCount: number;
  /** Grade of the config row actually used (may be lower than the requested grade). */
  configGradeLevel: number;
  settings: AssessmentSettings;
}

/* ------------------------------------------------------------------ */
/* Teacher administration (admin only)                                 */
/* ------------------------------------------------------------------ */

/** Admin = user listed in private.admin_users. Seeded once by the coordinator, never by the client. */
export interface TeacherSummary {
  userId: Uuid;
  email: string;
  fullName: string | null;
  /** false when the Auth account is disabled (banned) by an admin. */
  active: boolean;
  isAdmin: boolean;
  createdAt: IsoDateTime;
  /** false when the teacher has not signed in yet and has no profile. */
  hasProfile: boolean;
}

/**
 * Creates an Auth user (email confirmed), adds the email to the allowlist and
 * provisions the teacher profile (school and class as in provision-teacher).
 * The generated password is returned once and never stored or logged.
 */
export interface AddTeacherRequest {
  /** Lower-cased and trimmed server-side; must be a valid e-mail. */
  email: string;
  /** 1-120 characters. */
  fullName: string;
}
export interface AddTeacherData {
  teacher: TeacherSummary;
  /** 12+ characters, shown once to the admin. */
  temporaryPassword: string;
}

export type ListTeachersRequest = Record<string, never>;
export interface ListTeachersData {
  teachers: TeacherSummary[];
}

/** New generated password, returned once. Not allowed for the caller's own account. */
export interface ResetTeacherPasswordRequest {
  userId: Uuid;
}
export interface ResetTeacherPasswordData {
  userId: Uuid;
  temporaryPassword: string;
}

/** Disables or re-enables a teacher account (no data is deleted). Not allowed for admins or oneself. */
export interface SetTeacherActiveRequest {
  userId: Uuid;
  active: boolean;
}
export interface SetTeacherActiveData {
  teacher: TeacherSummary;
}

/* ------------------------------------------------------------------ */
/* Attempts (student only)                                             */
/* ------------------------------------------------------------------ */

export interface StartAttemptRequest {
  assignmentId: Uuid;
}
export interface StartAttemptData {
  attemptId: Uuid;
  /** true when an unexpired in-progress attempt was continued. */
  resumed: boolean;
  startedAt: IsoDateTime;
  /** Use to correct the device clock: offset = serverNow - Date.now() at receipt. */
  serverNow: IsoDateTime;
  /** null when the attempt has no time limit. */
  deadlineAt: IsoDateTime | null;
  mode: AssessmentMode;
  settings: AssessmentSettings;
  questions: PublicQuestion[];
  answeredQuestionIds: Uuid[];
}

export interface SubmitAnswerRequest {
  attemptId: Uuid;
  questionId: Uuid;
  response: AnswerResponse;
}
export interface SubmitAnswerData {
  accepted: true;
  /** Present only in practice mode (decision D5). Never present in graded mode. */
  feedback?: { isCorrect: boolean; awardedPoints: number };
}

export interface FinishAttemptRequest {
  attemptId: Uuid;
}
export interface FinishAttemptData {
  attemptId: Uuid;
  status: Exclude<AttemptStatus, "in_progress">;
  score: number;
  maxScore: number;
  /** score / maxScore * 100, rounded to 2 decimals. */
  percent: number;
  /** null when the assessment sets neither passPercent nor maxErrors. */
  passed: boolean | null;
  /** Questions not fully correct, including unanswered ones. */
  mistakes: number;
  questionCount: number;
  answeredCount: number;
  elapsedMs: number;
}

/* ------------------------------------------------------------------ */
/* Stored shapes (for the database implementer)                        */
/* ------------------------------------------------------------------ */

/** assessment_questions.prompt */
export interface StoredPrompt {
  text: string;
}

/** assessment_questions.choices: [] for true_false, numeric, short_answer. */
export type StoredChoices = PublicChoice[] | PublicMatchItem[];

/**
 * private.assessment_answer_keys.answer_key. The key shape is the same for
 * checker_version 1 (all-or-nothing) and 2 (partial credit for multiple_choice,
 * ordering and matching; rules in docs/API_CONTRACT.md, section 5).
 */
export type StoredAnswerKeyV1 =
  | { type: "true_false"; value: boolean }
  | { type: "single_choice"; choiceId: string }
  | { type: "multiple_choice"; choiceIds: string[] }
  | { type: "ordering"; order: string[] }
  | { type: "matching"; pairs: { leftId: string; rightId: string }[] }
  | { type: "numeric"; value: number; tolerance: number }
  | { type: "short_answer"; accepted: string[]; caseSensitive: boolean };

/* ------------------------------------------------------------------ */
/* Function registry                                                   */
/* ------------------------------------------------------------------ */

/** "authenticated" = a signed-in user who may not have a profile yet (only provision-teacher). */
export type CallerRole = "teacher" | "student" | "authenticated";

export interface FunctionContracts {
  "provision-teacher": { role: "authenticated"; request: ProvisionTeacherRequest; data: ProvisionTeacherData };
  "create-students": { role: "teacher"; request: CreateStudentsRequest; data: CreateStudentsData };
  "reset-student-password": { role: "teacher"; request: ResetStudentPasswordRequest; data: ResetStudentPasswordData };
  "delete-student": { role: "teacher"; request: DeleteStudentRequest; data: DeleteStudentData };
  "get-assessment-draft": { role: "teacher"; request: GetAssessmentDraftRequest; data: GetAssessmentDraftData };
  "upsert-question": { role: "teacher"; request: UpsertQuestionRequest; data: UpsertQuestionData };
  "delete-question": { role: "teacher"; request: DeleteQuestionRequest; data: DeleteQuestionData };
  "reorder-questions": { role: "teacher"; request: ReorderQuestionsRequest; data: ReorderQuestionsData };
  "publish-assessment": { role: "teacher"; request: PublishAssessmentRequest; data: PublishAssessmentData };
  "clone-assessment": { role: "teacher"; request: CloneAssessmentRequest; data: CloneAssessmentData };
  "create-class": { role: "teacher"; request: CreateClassRequest; data: CreateClassData };
  "set-class-subject": { role: "teacher"; request: SetClassSubjectRequest; data: SetClassSubjectData };
  "generate-multiplication-test": { role: "teacher"; request: GenerateMultiplicationTestRequest; data: GenerateMultiplicationTestData };
  "add-teacher": { role: "admin"; request: AddTeacherRequest; data: AddTeacherData };
  "list-teachers": { role: "admin"; request: ListTeachersRequest; data: ListTeachersData };
  "reset-teacher-password": { role: "admin"; request: ResetTeacherPasswordRequest; data: ResetTeacherPasswordData };
  "set-teacher-active": { role: "admin"; request: SetTeacherActiveRequest; data: SetTeacherActiveData };
  "start-attempt": { role: "student"; request: StartAttemptRequest; data: StartAttemptData };
  "submit-answer": { role: "student"; request: SubmitAnswerRequest; data: SubmitAnswerData };
  "finish-attempt": { role: "student"; request: FinishAttemptRequest; data: FinishAttemptData };
}

export type FunctionName = keyof FunctionContracts;

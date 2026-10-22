import type { SupabaseClient } from "@supabase/supabase-js";
import type { AssessmentMode, ApiResult, PublishAssessmentData } from "../../contracts/api";

export type AssignmentFailureReason = "duplicate" | "referenced" | "permission" | "database" | "not_found";
export type AssignmentMutationResult = { ok: true; id: string } | { ok: false; reason: AssignmentFailureReason };
export type PublishDraftResult = ApiResult<PublishAssessmentData> | { ok: false; reason: AssignmentFailureReason };
export interface NewAssignment {
  template_id: string;
  class_id: string;
  assigned_by: string;
  opens_at: string | null;
  closes_at: string | null;
  allow_retries: boolean;
}
export interface AssignmentWindow {
  opensAt: string | null;
  closesAt: string | null;
  allowRetries: boolean;
}
export function publishDraft(
  client: SupabaseClient,
  templateId: string,
  teacherId: string,
  mode: AssessmentMode,
  invoke: (client: SupabaseClient, name: "publish-assessment", body: { templateId: string }) => Promise<ApiResult<PublishAssessmentData>>,
): Promise<PublishDraftResult>;
export function validateQuestionsForPublication(
  questions: unknown[],
  isValidQuestion: (question: unknown) => boolean,
): { ok: true } | { ok: false; reason: "empty" | "invalid" };
export function createAssignment(client: SupabaseClient, values: NewAssignment): Promise<AssignmentMutationResult>;
export function updateAssignmentWindow(client: SupabaseClient, assignmentId: string, values: AssignmentWindow): Promise<AssignmentMutationResult>;
export function deleteAssignment(client: SupabaseClient, assignmentId: string): Promise<AssignmentMutationResult>;
export function toDateTimeLocal(value: string | null): string;
export function fromDateTimeLocal(value: string): string | null;
export function isValidAssignmentWindow(opensAt: string, closesAt: string): boolean;

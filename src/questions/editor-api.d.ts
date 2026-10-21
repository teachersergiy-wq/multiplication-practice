import type {
  AuthoredQuestion,
  DeleteQuestionRequest,
  GetAssessmentDraftRequest,
  ReorderQuestionsRequest,
  UpsertQuestionRequest,
} from "../../contracts/api";

export function upsertQuestionRequest(templateId: string, questionId: string | null, question: AuthoredQuestion): UpsertQuestionRequest;
export function getDraftRequest(templateId: string): GetAssessmentDraftRequest;
export function deleteQuestionRequest(questionId: string): DeleteQuestionRequest;
export function reorderQuestionsRequest(templateId: string, orderedQuestionIds: string[]): ReorderQuestionsRequest;


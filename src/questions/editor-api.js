/**
 * Keep editor mutations small and injectable so the contract payloads can be
 * checked with mocked function calls without touching Supabase.
 */
export function upsertQuestionRequest(templateId, questionId, question) {
  return {
    templateId,
    ...(questionId ? { questionId } : {}),
    question,
  };
}

export function getDraftRequest(templateId) {
  return { templateId };
}

export function deleteQuestionRequest(questionId) {
  return { questionId };
}

export function reorderQuestionsRequest(templateId, orderedQuestionIds) {
  return { templateId, orderedQuestionIds };
}


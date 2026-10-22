import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiResult, ErrorCode, FunctionContracts, FunctionName } from "../../contracts/api";

const errorCodes: ErrorCode[] = [
  "invalid_request",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "incomplete_assessment",
  "assignment_not_open",
  "assignment_closed",
  "retry_not_allowed",
  "attempt_not_in_progress",
  "attempt_expired",
  "already_answered",
  "rate_limited",
  "internal",
];

const apiErrorMessages: Record<ErrorCode, string> = {
  invalid_request: "Перевірте введені дані й спробуйте ще раз.",
  unauthenticated: "Сеанс завершився. Увійдіть знову.",
  forbidden: "Цей обліковий запис не має доступу до вчительського кабінету.",
  not_found: "Потрібні дані не знайдено. Оновіть сторінку й спробуйте ще раз.",
  conflict: "Дію не можна виконати в поточному стані.",
  incomplete_assessment: "У тесті є запитання без правильної відповіді. Перевірте кожне запитання й спробуйте ще раз.",
  assignment_not_open: "Завдання ще не відкрите.",
  assignment_closed: "Час виконання цього завдання завершився.",
  retry_not_allowed: "Для цього завдання повторна спроба недоступна.",
  attempt_not_in_progress: "Спроба вже завершена.",
  attempt_expired: "Час виконання завершився.",
  already_answered: "На це запитання вже надано відповідь.",
  rate_limited: "Забагато запитів. Зачекайте трохи й спробуйте знову.",
  internal: "Сервіс тимчасово недоступний. Спробуйте пізніше.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseApiResult<T>(value: unknown): ApiResult<T> | null {
  if (!isRecord(value)) return null;
  if (value.ok === true && "data" in value) return { ok: true, data: value.data as T };
  if (value.ok !== false || !isRecord(value.error)) return null;

  const { code, message, details } = value.error;
  if (
    typeof code !== "string" ||
    !errorCodes.includes(code as ErrorCode) ||
    typeof message !== "string" ||
    (details !== undefined && !isRecord(details))
  ) return null;

  return {
    ok: false,
    error: {
      code: code as ErrorCode,
      message,
      ...(isRecord(details) ? { details } : {}),
    },
  };
}

export function apiErrorMessage(code: ErrorCode): string {
  return apiErrorMessages[code];
}

export async function invokeFunction<Name extends FunctionName>(
  client: SupabaseClient,
  name: Name,
  body: FunctionContracts[Name]["request"],
): Promise<ApiResult<FunctionContracts[Name]["data"]>> {
  try {
    const { data, error } = await client.functions.invoke(name, { body });
    let payload: unknown = data;

    if (payload === null && error && "context" in error) {
      const response = (error as { context?: unknown }).context;
      if (response instanceof Response) {
        payload = await response.clone().json().catch(() => null);
      }
    }

    return parseApiResult<FunctionContracts[Name]["data"]>(payload) ?? {
      ok: false,
      error: { code: "internal", message: "Invalid API response" },
    };
  } catch {
    return { ok: false, error: { code: "internal", message: "Function request failed" } };
  }
}


import { corsHeaders } from "./cors.ts";

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

const HTTP_STATUS_BY_ERROR: Record<ErrorCode, number> = {
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

export function jsonOk<T>(req: Request, data: T, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

export function jsonErr(
  req: Request,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): Response {
  const body: {
    ok: false;
    error: { code: ErrorCode; message: string; details?: Record<string, unknown> };
  } = {
    ok: false,
    error: details ? { code, message, details } : { code, message },
  };
  return new Response(JSON.stringify(body), {
    status: HTTP_STATUS_BY_ERROR[code],
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

/** submit-answer — student; practice returns feedback; graded never leaks correctness. */
import { handleOptions } from "../_shared/cors.ts";
import { jsonErr, jsonOk } from "../_shared/http.ts";
import { adminClient, userClient } from "../_shared/supabase.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST") return jsonErr(req, "invalid_request", "POST required");

  try {
    const userSb = userClient(req);
    const {
      data: { user },
      error: userErr,
    } = await userSb.auth.getUser();
    if (userErr || !user) return jsonErr(req, "unauthenticated", "Valid access token required");

    const admin = adminClient();
    const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).maybeSingle();
    if (!profile || profile.role !== "student") {
      return jsonErr(req, "forbidden", "Student profile required");
    }

    let body: { attemptId?: unknown; questionId?: unknown; response?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonErr(req, "invalid_request", "JSON body required");
    }
    const allowed = new Set(["attemptId", "questionId", "response"]);
    for (const k of Object.keys(body as Record<string, unknown>)) {
      if (!allowed.has(k)) return jsonErr(req, "invalid_request", `Unknown field: ${k}`);
    }
    if (typeof body.attemptId !== "string" || !UUID_RE.test(body.attemptId)) {
      return jsonErr(req, "invalid_request", "attemptId must be a UUID");
    }
    if (typeof body.questionId !== "string" || !UUID_RE.test(body.questionId)) {
      return jsonErr(req, "invalid_request", "questionId must be a UUID");
    }
    if (!body.response || typeof body.response !== "object") {
      return jsonErr(req, "invalid_request", "response required");
    }

    const { data, error } = await admin.rpc("api_submit_answer", {
      p_attempt_id: body.attemptId,
      p_student_id: user.id,
      p_question_id: body.questionId,
      p_response: body.response,
    });
    if (error) {
      const msg = error.message ?? "";
      if (msg.includes("not_found")) return jsonErr(req, "not_found", "Attempt not found");
      if (msg.includes("attempt_not_in_progress")) {
        return jsonErr(req, "attempt_not_in_progress", "Attempt not in progress");
      }
      if (msg.includes("attempt_expired")) return jsonErr(req, "attempt_expired", "Attempt expired");
      if (msg.includes("already_answered")) return jsonErr(req, "already_answered", "Already answered");
      if (msg.includes("invalid_request")) {
        return jsonErr(req, "invalid_request", msg.replace(/^.*invalid_request:\s*/i, "") || "Invalid request");
      }
      console.error("api_submit_answer failed");
      return jsonErr(req, "internal", "Submit failed");
    }
    // G6b: expired attempt is finalized as abandoned in SQL and returned as data;
    // map to attempt_expired so the client sees the contract error code.
    if (data && typeof data === "object" && (data as { expired?: boolean }).expired === true) {
      return jsonErr(req, "attempt_expired", "Attempt expired");
    }
    return jsonOk(req, data);
  } catch {
    console.error("submit-answer unexpected");
    return jsonErr(req, "internal", "Unexpected error");
  }
});

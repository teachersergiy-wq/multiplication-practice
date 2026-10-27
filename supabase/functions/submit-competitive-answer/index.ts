/** submit-competitive-answer — student answers current competitive question. */
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
    const { data: { user }, error: userErr } = await userSb.auth.getUser();
    if (userErr || !user) return jsonErr(req, "unauthenticated", "Valid access token required");

    let body: { runId?: unknown; questionId?: unknown; response?: unknown };
    try {
      body = await req.json();
    } catch {
      return jsonErr(req, "invalid_request", "JSON body required");
    }
    if (typeof body.runId !== "string" || !UUID_RE.test(body.runId)) {
      return jsonErr(req, "invalid_request", "runId must be UUID");
    }
    if (typeof body.questionId !== "string" || !UUID_RE.test(body.questionId)) {
      return jsonErr(req, "invalid_request", "questionId must be UUID");
    }
    if (!body.response || typeof body.response !== "object") {
      return jsonErr(req, "invalid_request", "response required");
    }

    const admin = adminClient();
    const { data, error } = await admin.rpc("api_submit_competitive_answer", {
      p_student_id: user.id,
      p_run_id: body.runId,
      p_question_id: body.questionId,
      p_response: body.response,
    });
    if (error) {
      console.error("api_submit_competitive_answer", error.code ?? "", (error.message ?? "").slice(0, 120));
      const msg = error.message ?? "";
      if (msg.includes("rate_limited")) return jsonErr(req, "rate_limited", "Answer too fast");
      if (msg.includes("not_found")) return jsonErr(req, "not_found", "Run not found");
      if (msg.includes("conflict")) return jsonErr(req, "conflict", "Run finished");
      if (msg.includes("invalid_request")) return jsonErr(req, "invalid_request", "Invalid request");
      return jsonErr(req, "internal", "Submit failed");
    }
    return jsonOk(req, data);
  } catch {
    console.error("submit-competitive-answer unexpected");
    return jsonErr(req, "internal", "Unexpected error");
  }
});

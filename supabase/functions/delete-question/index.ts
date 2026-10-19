/**
 * delete-question — teacher owner, draft template only.
 */
import { handleOptions } from "../_shared/cors.ts";
import { jsonErr, jsonOk } from "../_shared/http.ts";
import { adminClient, userClient } from "../_shared/supabase.ts";
import { requireTeacher } from "../_shared/authz.ts";

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
    if (userErr || !user) {
      return jsonErr(req, "unauthenticated", "Valid access token required");
    }

    const admin = adminClient();
    const teacher = await requireTeacher(admin, user.id);
    if (!teacher.ok) return jsonErr(req, teacher.code, teacher.message);

    let body: { questionId?: unknown };
    try {
      body = (await req.json()) as { questionId?: unknown };
    } catch {
      return jsonErr(req, "invalid_request", "JSON body required");
    }
    for (const k of Object.keys(body as Record<string, unknown>)) {
      if (k !== "questionId") return jsonErr(req, "invalid_request", `Unknown field: ${k}`);
    }
    if (typeof body.questionId !== "string" || !UUID_RE.test(body.questionId)) {
      return jsonErr(req, "invalid_request", "questionId must be a UUID");
    }

    const { error } = await admin.rpc("api_delete_question", {
      p_question_id: body.questionId,
      p_teacher_id: user.id,
    });
    if (error) {
      const msg = error.message ?? "";
      if (msg.includes("not_found")) return jsonErr(req, "not_found", "Question not found");
      if (msg.includes("conflict")) return jsonErr(req, "conflict", "Template is not a draft");
      console.error("api_delete_question failed");
      return jsonErr(req, "internal", "Delete failed");
    }

    return jsonOk(req, { deleted: true as const });
  } catch {
    console.error("delete-question unexpected error");
    return jsonErr(req, "internal", "Unexpected error");
  }
});

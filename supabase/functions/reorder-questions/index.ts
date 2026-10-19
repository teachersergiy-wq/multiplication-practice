/**
 * reorder-questions — teacher owner, draft; orderedQuestionIds must list every question once.
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

    let body: { templateId?: unknown; orderedQuestionIds?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonErr(req, "invalid_request", "JSON body required");
    }
    const allowed = new Set(["templateId", "orderedQuestionIds"]);
    for (const k of Object.keys(body as Record<string, unknown>)) {
      if (!allowed.has(k)) return jsonErr(req, "invalid_request", `Unknown field: ${k}`);
    }

    if (typeof body.templateId !== "string" || !UUID_RE.test(body.templateId)) {
      return jsonErr(req, "invalid_request", "templateId must be a UUID");
    }
    if (!Array.isArray(body.orderedQuestionIds) || body.orderedQuestionIds.length < 1) {
      return jsonErr(req, "invalid_request", "orderedQuestionIds required");
    }
    const ids: string[] = [];
    for (const id of body.orderedQuestionIds) {
      if (typeof id !== "string" || !UUID_RE.test(id)) {
        return jsonErr(req, "invalid_request", "orderedQuestionIds must be UUIDs");
      }
      ids.push(id);
    }

    const { error } = await admin.rpc("api_reorder_questions", {
      p_template_id: body.templateId,
      p_teacher_id: user.id,
      p_ordered_ids: ids,
    });
    if (error) {
      const msg = error.message ?? "";
      if (msg.includes("not_found")) return jsonErr(req, "not_found", "Template not found");
      if (msg.includes("conflict")) return jsonErr(req, "conflict", "Template is not a draft");
      if (msg.includes("invalid_request")) {
        return jsonErr(req, "invalid_request", msg.replace(/^.*invalid_request:\s*/i, "") || msg);
      }
      console.error("api_reorder_questions failed");
      return jsonErr(req, "internal", "Reorder failed");
    }

    return jsonOk(req, { reordered: true as const });
  } catch {
    console.error("reorder-questions unexpected error");
    return jsonErr(req, "internal", "Unexpected error");
  }
});

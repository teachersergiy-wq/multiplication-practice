/**
 * bulk-update-questions — teacher owner; draft only.
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

    let body: {
      templateId?: unknown;
      questionIds?: unknown;
      update?: unknown;
      delete?: unknown;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonErr(req, "invalid_request", "JSON body required");
    }

    if (typeof body.templateId !== "string" || !UUID_RE.test(body.templateId)) {
      return jsonErr(req, "invalid_request", "templateId must be a UUID");
    }
    if (!Array.isArray(body.questionIds) || body.questionIds.length < 1 || body.questionIds.length > 500) {
      return jsonErr(req, "invalid_request", "questionIds 1–500");
    }
    for (const id of body.questionIds) {
      if (typeof id !== "string" || !UUID_RE.test(id)) {
        return jsonErr(req, "invalid_request", "questionIds must be UUIDs");
      }
    }

    const doDelete = body.delete === true;
    const hasUpdate = body.update !== undefined && body.update !== null;
    if (doDelete === hasUpdate) {
      return jsonErr(req, "invalid_request", "exactly one of update or delete");
    }

    const { data, error } = await admin.rpc("api_bulk_update_questions", {
      p_teacher_id: user.id,
      p_template_id: body.templateId,
      p_question_ids: body.questionIds,
      p_update: doDelete ? null : body.update,
      p_delete: doDelete,
    });

    if (error) {
      console.error(
        "api_bulk_update_questions",
        error.code ?? "",
        (error.message ?? "").slice(0, 120),
      );
      const msg = error.message ?? "";
      if (msg.includes("not_found")) return jsonErr(req, "not_found", "Template not found");
      if (msg.includes("conflict")) return jsonErr(req, "conflict", "Template is not a draft");
      if (msg.includes("invalid_request")) {
        return jsonErr(req, "invalid_request", "Invalid bulk update");
      }
      return jsonErr(req, "internal", "Bulk update failed");
    }

    return jsonOk(req, data as { updatedCount: number; deletedCount: number });
  } catch {
    console.error("bulk-update-questions unexpected error");
    return jsonErr(req, "internal", "Unexpected error");
  }
});

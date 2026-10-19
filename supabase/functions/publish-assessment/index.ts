/**
 * publish-assessment — teacher owner, draft only; status change only via this path (D3).
 * Never returns answer keys.
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

    let body: { templateId?: unknown };
    try {
      body = (await req.json()) as { templateId?: unknown };
    } catch {
      return jsonErr(req, "invalid_request", "JSON body required");
    }
    for (const k of Object.keys(body as Record<string, unknown>)) {
      if (k !== "templateId") return jsonErr(req, "invalid_request", `Unknown field: ${k}`);
    }
    if (typeof body.templateId !== "string" || !UUID_RE.test(body.templateId)) {
      return jsonErr(req, "invalid_request", "templateId must be a UUID");
    }

    const { data, error } = await admin.rpc("api_publish_assessment", {
      p_template_id: body.templateId,
      p_teacher_id: user.id,
    });

    if (error) {
      const msg = error.message ?? "";
      if (msg.includes("not_found")) return jsonErr(req, "not_found", "Template not found");
      if (msg.includes("conflict")) return jsonErr(req, "conflict", "Template is not a draft");
      if (msg.includes("incomplete_assessment")) {
        const m = msg.match(/bad questions\s+([0-9a-f,-]+)/i);
        const questionIds = m?.[1] ? m[1].split(",").filter(Boolean) : undefined;
        return jsonErr(
          req,
          "incomplete_assessment",
          "Assessment is incomplete",
          questionIds ? { questionIds } : undefined,
        );
      }
      console.error("api_publish_assessment failed");
      return jsonErr(req, "internal", "Publish failed");
    }

    return jsonOk(req, data as {
      templateId: string;
      status: "published";
      questionCount: number;
      totalPoints: number;
    });
  } catch {
    console.error("publish-assessment unexpected error");
    return jsonErr(req, "internal", "Unexpected error");
  }
});

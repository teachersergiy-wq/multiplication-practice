/** get-competitive-results — teacher view of class competitive stats. */
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
    const { data: { user }, error: userErr } = await userSb.auth.getUser();
    if (userErr || !user) return jsonErr(req, "unauthenticated", "Valid access token required");

    const admin = adminClient();
    const teacher = await requireTeacher(admin, user.id);
    if (!teacher.ok) return jsonErr(req, teacher.code, teacher.message);

    let body: { classId?: unknown; topicCode?: unknown };
    try {
      body = await req.json();
    } catch {
      return jsonErr(req, "invalid_request", "JSON body required");
    }
    if (typeof body.classId !== "string" || !UUID_RE.test(body.classId)) {
      return jsonErr(req, "invalid_request", "classId must be UUID");
    }
    const topicCode = typeof body.topicCode === "string" ? body.topicCode : null;

    const { data, error } = await admin.rpc("api_get_competitive_results", {
      p_teacher_id: user.id,
      p_class_id: body.classId,
      p_topic_code: topicCode,
    });
    if (error) {
      console.error("api_get_competitive_results", error.code ?? "", (error.message ?? "").slice(0, 120));
      const msg = error.message ?? "";
      if (msg.includes("not_found")) return jsonErr(req, "not_found", "Class not found");
      return jsonErr(req, "internal", "Results failed");
    }
    return jsonOk(req, data);
  } catch {
    console.error("get-competitive-results unexpected");
    return jsonErr(req, "internal", "Unexpected error");
  }
});

/** set-teacher-active — admin only; ban/unban Auth account. */
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
    if (userErr || !user) {
      return jsonErr(req, "unauthenticated", "Valid access token required");
    }

    let body: { userId?: unknown; active?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonErr(req, "invalid_request", "JSON body required");
    }
    if (typeof body.userId !== "string" || !UUID_RE.test(body.userId)) {
      return jsonErr(req, "invalid_request", "userId must be a UUID");
    }
    if (typeof body.active !== "boolean") {
      return jsonErr(req, "invalid_request", "active must be boolean");
    }

    const admin = adminClient();
    const { error: assertErr } = await admin.rpc("api_admin_assert_manage_teacher", {
      p_admin_id: user.id,
      p_target_id: body.userId,
      p_forbid_admin: true,
    });
    if (assertErr) {
      const msg = assertErr.message ?? "";
      if (msg.includes("forbidden")) {
        return jsonErr(req, "forbidden", msg.includes("admin") ? "Cannot manage admin" : "Admin required");
      }
      if (msg.includes("invalid_request")) {
        return jsonErr(req, "invalid_request", "Cannot change own active state");
      }
      console.error("assert_manage failed");
      return jsonErr(req, "internal", "Check failed");
    }

    const { error: banErr } = await admin.auth.admin.updateUserById(body.userId, {
      ban_duration: body.active ? "none" : "876000h",
    });
    if (banErr) {
      console.error("ban update failed");
      return jsonErr(req, "internal", "Active state update failed");
    }

    await admin.rpc("api_admin_write_audit", {
      p_actor: user.id,
      p_action: body.active ? "teacher_activate" : "teacher_deactivate",
      p_target: body.userId,
    });

    const { data: summary, error: sumErr } = await admin.rpc("api_admin_teacher_summary", {
      p_user_id: body.userId,
    });
    if (sumErr || !summary) {
      console.error("teacher_summary failed");
      return jsonErr(req, "internal", "Summary failed");
    }

    return jsonOk(req, { teacher: summary });
  } catch {
    console.error("set-teacher-active unexpected error");
    return jsonErr(req, "internal", "Unexpected error");
  }
});

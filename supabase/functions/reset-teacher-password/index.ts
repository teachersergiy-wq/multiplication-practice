/** reset-teacher-password — admin only; not for self. */
import { handleOptions } from "../_shared/cors.ts";
import { jsonErr, jsonOk } from "../_shared/http.ts";
import { adminClient, userClient } from "../_shared/supabase.ts";
import { generateSecurePassword } from "../_shared/password.ts";

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

    let body: { userId?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonErr(req, "invalid_request", "JSON body required");
    }
    if (typeof body.userId !== "string" || !UUID_RE.test(body.userId)) {
      return jsonErr(req, "invalid_request", "userId must be a UUID");
    }

    const admin = adminClient();
    const { error: assertErr } = await admin.rpc("api_admin_assert_manage_teacher", {
      p_admin_id: user.id,
      p_target_id: body.userId,
      p_forbid_admin: false,
    });
    if (assertErr) {
      const msg = assertErr.message ?? "";
      if (msg.includes("forbidden")) return jsonErr(req, "forbidden", "Admin required");
      if (msg.includes("invalid_request")) {
        return jsonErr(req, "invalid_request", "Cannot reset own password");
      }
      console.error("assert_manage failed");
      return jsonErr(req, "internal", "Check failed");
    }

    const temporaryPassword = generateSecurePassword(14);
    const { error: updErr } = await admin.auth.admin.updateUserById(body.userId, {
      password: temporaryPassword,
    });
    if (updErr) {
      console.error("updateUser password failed");
      return jsonErr(req, "internal", "Password update failed");
    }

    await admin.rpc("api_admin_write_audit", {
      p_actor: user.id,
      p_action: "reset_teacher_password",
      p_target: body.userId,
    });

    return jsonOk(req, {
      userId: body.userId,
      temporaryPassword,
    });
  } catch {
    console.error("reset-teacher-password unexpected error");
    return jsonErr(req, "internal", "Unexpected error");
  }
});

/**
 * add-teacher — admin only; create Auth user, allowlist, provision profile.
 */
import { handleOptions } from "../_shared/cors.ts";
import { jsonErr, jsonOk } from "../_shared/http.ts";
import { adminClient, userClient } from "../_shared/supabase.ts";
import { generateSecurePassword } from "../_shared/password.ts";

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

    const { error: reqErr } = await admin.rpc("api_admin_require", {
      p_user_id: user.id,
    });
    if (reqErr) {
      const msg = reqErr.message ?? "";
      if (msg.includes("forbidden")) {
        return jsonErr(req, "forbidden", "Admin required");
      }
      console.error("api_admin_require failed");
      return jsonErr(req, "internal", "Admin check failed");
    }

    let body: { email?: unknown; fullName?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonErr(req, "invalid_request", "JSON body required");
    }
    for (const k of Object.keys(body as Record<string, unknown>)) {
      if (k !== "email" && k !== "fullName") {
        return jsonErr(req, "invalid_request", `Unknown field: ${k}`);
      }
    }
    if (typeof body.email !== "string") {
      return jsonErr(req, "invalid_request", "email required");
    }
    const email = body.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return jsonErr(req, "invalid_request", "invalid email");
    }
    if (typeof body.fullName !== "string") {
      return jsonErr(req, "invalid_request", "fullName required");
    }
    const fullName = body.fullName.trim();
    if (fullName.length < 1 || fullName.length > 120) {
      return jsonErr(req, "invalid_request", "fullName length 1–120");
    }

    const temporaryPassword = generateSecurePassword(14);

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password: temporaryPassword,
      email_confirm: true,
      user_metadata: { role: "teacher" },
    });

    if (createErr || !created.user) {
      const m = (createErr?.message ?? "").toLowerCase();
      if (m.includes("already") || m.includes("registered") || m.includes("exists")) {
        return jsonErr(req, "conflict", "Email already registered");
      }
      console.error("createUser failed");
      return jsonErr(req, "internal", "Auth create failed");
    }

    const newId = created.user.id;

    const { data: reg, error: regErr } = await admin.rpc("api_admin_register_teacher", {
      p_admin_id: user.id,
      p_user_id: newId,
      p_email: email,
      p_full_name: fullName,
    });

    if (regErr) {
      try {
        await admin.auth.admin.deleteUser(newId);
      } catch {
        console.error("compensation deleteUser failed");
      }
      const msg = regErr.message ?? "";
      if (msg.includes("conflict")) {
        return jsonErr(req, "conflict", "Email already on allowlist or limit");
      }
      if (msg.includes("invalid_request")) {
        return jsonErr(req, "invalid_request", "Invalid teacher data");
      }
      console.error("api_admin_register_teacher failed");
      return jsonErr(req, "internal", "Register teacher failed");
    }

    const row = reg as {
      userId: string;
      email: string;
      fullName: string | null;
      active: boolean;
      isAdmin: boolean;
      createdAt: string;
      hasProfile: boolean;
    };

    return jsonOk(req, {
      teacher: {
        userId: row.userId,
        email: row.email,
        fullName: row.fullName,
        active: row.active,
        isAdmin: row.isAdmin,
        createdAt: row.createdAt,
        hasProfile: row.hasProfile,
      },
      temporaryPassword,
    });
  } catch {
    console.error("add-teacher unexpected error");
    return jsonErr(req, "internal", "Unexpected error");
  }
});

/**
 * provision-teacher — API_CONTRACT / FunctionContracts["provision-teacher"]
 * Role: authenticated (may not have a profile yet).
 * Allowlist + atomic create via public.api_* (service_role only; private not in PostgREST).
 */
import { handleOptions } from "../_shared/cors.ts";
import { jsonErr, jsonOk } from "../_shared/http.ts";
import { adminClient, userClient } from "../_shared/supabase.ts";

interface Body {
  fullName?: unknown;
  schoolName?: unknown;
  className?: unknown;
}

function asTrimmedString(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length < 1 || t.length > max) return null;
  return t;
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST") {
    return jsonErr(req, "invalid_request", "POST required");
  }

  try {
    const userSb = userClient(req);
    const {
      data: { user },
      error: userErr,
    } = await userSb.auth.getUser();
    if (userErr || !user) {
      return jsonErr(req, "unauthenticated", "Valid access token required");
    }

    if (!user.email_confirmed_at) {
      return jsonErr(req, "forbidden", "Email is not confirmed");
    }

    const email = (user.email ?? "").toLowerCase().trim();
    if (!email) {
      return jsonErr(req, "forbidden", "Account has no email");
    }

    const admin = adminClient();

    const { data: allowed, error: allowErr } = await admin.rpc(
      "api_is_allowed_teacher",
      { p_email: email },
    );
    if (allowErr) {
      console.error("allowlist rpc failed");
      return jsonErr(req, "internal", "Allowlist lookup failed");
    }
    if (allowed !== true) {
      return jsonErr(req, "forbidden", "Email is not on the teacher allowlist");
    }

    let body: Body = {};
    const raw = await req.text();
    if (raw && raw.trim().length > 0) {
      try {
        body = JSON.parse(raw) as Body;
      } catch {
        return jsonErr(req, "invalid_request", "JSON body required");
      }
    }

    const allowedKeys = new Set(["fullName", "schoolName", "className"]);
    for (const k of Object.keys(body as Record<string, unknown>)) {
      if (!allowedKeys.has(k)) {
        return jsonErr(req, "invalid_request", `Unknown field: ${k}`);
      }
    }

    // For idempotent path fullName may be ignored; for create it is required.
    const fullName = asTrimmedString(body.fullName, 160);
    const schoolName = asTrimmedString(body.schoolName, 160) ?? "Моя школа";
    const className = asTrimmedString(body.className, 80) ?? "Мій клас";

    // Probe existing role cheaply via provision RPC (handles both create and idempotent).
    if (!fullName || fullName.length < 2) {
      // Still allow idempotent return if profile already exists: pass placeholder only if needed.
      // api_provision_teacher ignores name when teacher already exists.
      const { data: probe, error: probeErr } = await admin.rpc("api_provision_teacher", {
        p_user_id: user.id,
        p_full_name: fullName ?? "",
        p_school_name: schoolName,
        p_class_name: className,
      });
      if (probeErr) {
        const msg = probeErr.message ?? "";
        if (msg.includes("forbidden")) {
          return jsonErr(req, "forbidden", "Not allowed to provision as teacher");
        }
        if (!fullName || fullName.length < 2) {
          return jsonErr(req, "invalid_request", "fullName required (2–160 chars)");
        }
        console.error("provision rpc failed");
        return jsonErr(req, "internal", "Provisioning failed");
      }
      const d = probe as {
        profileId: string;
        schoolId: string;
        classId: string;
        created: boolean;
      };
      return jsonOk(req, d);
    }

    const { data, error } = await admin.rpc("api_provision_teacher", {
      p_user_id: user.id,
      p_full_name: fullName,
      p_school_name: schoolName,
      p_class_name: className,
    });

    if (error) {
      const msg = error.message ?? "";
      if (msg.includes("forbidden")) {
        return jsonErr(req, "forbidden", "Not allowed to provision as teacher");
      }
      console.error("provision rpc failed");
      return jsonErr(req, "internal", "Provisioning failed");
    }

    const d = data as {
      profileId: string;
      schoolId: string;
      classId: string;
      created: boolean;
    };
    return jsonOk(req, d);
  } catch {
    console.error("provision-teacher unexpected error");
    return jsonErr(req, "internal", "Unexpected error");
  }
});

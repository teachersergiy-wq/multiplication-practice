/** finish-attempt — student owner; idempotent server scoring. */
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
    if (userErr || !user) return jsonErr(req, "unauthenticated", "Valid access token required");

    const admin = adminClient();
    const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).maybeSingle();
    if (!profile || profile.role !== "student") {
      return jsonErr(req, "forbidden", "Student profile required");
    }

    let body: { attemptId?: unknown };
    try {
      body = (await req.json()) as { attemptId?: unknown };
    } catch {
      return jsonErr(req, "invalid_request", "JSON body required");
    }
    for (const k of Object.keys(body as Record<string, unknown>)) {
      if (k !== "attemptId") return jsonErr(req, "invalid_request", `Unknown field: ${k}`);
    }
    if (typeof body.attemptId !== "string" || !UUID_RE.test(body.attemptId)) {
      return jsonErr(req, "invalid_request", "attemptId must be a UUID");
    }

    const { data, error } = await admin.rpc("api_finish_attempt", {
      p_attempt_id: body.attemptId,
      p_student_id: user.id,
    });
    if (error) {
      const msg = error.message ?? "";
      if (msg.includes("not_found")) return jsonErr(req, "not_found", "Attempt not found");
      console.error("api_finish_attempt failed");
      return jsonErr(req, "internal", "Finish failed");
    }
    return jsonOk(req, data);
  } catch {
    console.error("finish-attempt unexpected");
    return jsonErr(req, "internal", "Unexpected error");
  }
});

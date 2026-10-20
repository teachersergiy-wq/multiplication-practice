/** start-attempt — student only; public questions without keys. */
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

    let body: { assignmentId?: unknown };
    try {
      body = (await req.json()) as { assignmentId?: unknown };
    } catch {
      return jsonErr(req, "invalid_request", "JSON body required");
    }
    for (const k of Object.keys(body as Record<string, unknown>)) {
      if (k !== "assignmentId") return jsonErr(req, "invalid_request", `Unknown field: ${k}`);
    }
    if (typeof body.assignmentId !== "string" || !UUID_RE.test(body.assignmentId)) {
      return jsonErr(req, "invalid_request", "assignmentId must be a UUID");
    }

    const { data, error } = await admin.rpc("api_start_attempt", {
      p_assignment_id: body.assignmentId,
      p_student_id: user.id,
    });
    if (error) {
      const msg = error.message ?? "";
      if (msg.includes("not_found")) return jsonErr(req, "not_found", "Assignment not found");
      if (msg.includes("assignment_not_open")) return jsonErr(req, "assignment_not_open", "Assignment not open yet");
      if (msg.includes("assignment_closed")) return jsonErr(req, "assignment_closed", "Assignment closed");
      if (msg.includes("retry_not_allowed")) return jsonErr(req, "retry_not_allowed", "Retries not allowed");
      if (msg.includes("forbidden")) return jsonErr(req, "forbidden", "Not allowed");
      console.error("api_start_attempt failed");
      return jsonErr(req, "internal", "Start attempt failed");
    }
    return jsonOk(req, data);
  } catch {
    console.error("start-attempt unexpected");
    return jsonErr(req, "internal", "Unexpected error");
  }
});

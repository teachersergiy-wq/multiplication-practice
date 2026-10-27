/** publish-competitive-result — set visibility for Super-level result. */
import { handleOptions } from "../_shared/cors.ts";
import { jsonErr, jsonOk } from "../_shared/http.ts";
import { adminClient, userClient } from "../_shared/supabase.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VIS = new Set(["none", "nickname", "anonymous", "name"]);

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST") return jsonErr(req, "invalid_request", "POST required");
  try {
    const userSb = userClient(req);
    const { data: { user }, error: userErr } = await userSb.auth.getUser();
    if (userErr || !user) return jsonErr(req, "unauthenticated", "Valid access token required");

    let body: { runId?: unknown; visibility?: unknown };
    try {
      body = await req.json();
    } catch {
      return jsonErr(req, "invalid_request", "JSON body required");
    }
    if (typeof body.runId !== "string" || !UUID_RE.test(body.runId)) {
      return jsonErr(req, "invalid_request", "runId must be UUID");
    }
    if (typeof body.visibility !== "string" || !VIS.has(body.visibility)) {
      return jsonErr(req, "invalid_request", "visibility invalid");
    }

    const admin = adminClient();
    const { data, error } = await admin.rpc("api_publish_competitive_result", {
      p_student_id: user.id,
      p_run_id: body.runId,
      p_visibility: body.visibility,
    });
    if (error) {
      console.error("api_publish_competitive_result", error.code ?? "", (error.message ?? "").slice(0, 120));
      const msg = error.message ?? "";
      if (msg.includes("not_found")) return jsonErr(req, "not_found", "Run not found");
      if (msg.includes("conflict")) return jsonErr(req, "conflict", "Run in progress");
      if (msg.includes("invalid_request")) return jsonErr(req, "invalid_request", "Invalid request");
      return jsonErr(req, "internal", "Publish failed");
    }
    return jsonOk(req, data);
  } catch {
    console.error("publish-competitive-result unexpected");
    return jsonErr(req, "internal", "Unexpected error");
  }
});

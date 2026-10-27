/** get-leaderboard — class/school/year/absolute competitive ranking. */
import { handleOptions } from "../_shared/cors.ts";
import { jsonErr, jsonOk } from "../_shared/http.ts";
import { adminClient, userClient } from "../_shared/supabase.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCOPES = new Set(["class", "school", "school_year", "absolute"]);

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST") return jsonErr(req, "invalid_request", "POST required");
  try {
    const userSb = userClient(req);
    const { data: { user }, error: userErr } = await userSb.auth.getUser();
    if (userErr || !user) return jsonErr(req, "unauthenticated", "Valid access token required");

    let body: { topicCode?: unknown; scope?: unknown; limit?: unknown; classId?: unknown };
    try {
      body = await req.json();
    } catch {
      return jsonErr(req, "invalid_request", "JSON body required");
    }
    if (typeof body.topicCode !== "string" || !body.topicCode) {
      return jsonErr(req, "invalid_request", "topicCode required");
    }
    if (typeof body.scope !== "string" || !SCOPES.has(body.scope)) {
      return jsonErr(req, "invalid_request", "scope invalid");
    }
    const limit = typeof body.limit === "number" && Number.isInteger(body.limit) ? body.limit : 10;
    const classId =
      typeof body.classId === "string" && UUID_RE.test(body.classId) ? body.classId : null;

    const admin = adminClient();
    const { data, error } = await admin.rpc("api_get_leaderboard", {
      p_caller_id: user.id,
      p_topic_code: body.topicCode,
      p_scope: body.scope,
      p_limit: limit,
      p_class_id: classId,
    });
    if (error) {
      console.error("api_get_leaderboard", error.code ?? "", (error.message ?? "").slice(0, 120));
      const msg = error.message ?? "";
      if (msg.includes("not_found")) return jsonErr(req, "not_found", "Not found");
      if (msg.includes("invalid_request")) return jsonErr(req, "invalid_request", "Invalid request");
      return jsonErr(req, "internal", "Leaderboard failed");
    }
    return jsonOk(req, data);
  } catch {
    console.error("get-leaderboard unexpected");
    return jsonErr(req, "internal", "Unexpected error");
  }
});

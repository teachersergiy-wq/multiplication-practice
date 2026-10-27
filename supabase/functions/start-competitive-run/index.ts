/** start-competitive-run — student starts a level run. */
import { handleOptions } from "../_shared/cors.ts";
import { jsonErr, jsonOk } from "../_shared/http.ts";
import { adminClient, userClient } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST") return jsonErr(req, "invalid_request", "POST required");
  try {
    const userSb = userClient(req);
    const { data: { user }, error: userErr } = await userSb.auth.getUser();
    if (userErr || !user) return jsonErr(req, "unauthenticated", "Valid access token required");

    let body: { topicCode?: unknown; levelNumber?: unknown };
    try {
      body = await req.json();
    } catch {
      return jsonErr(req, "invalid_request", "JSON body required");
    }
    if (typeof body.topicCode !== "string" || !body.topicCode) {
      return jsonErr(req, "invalid_request", "topicCode required");
    }
    if (typeof body.levelNumber !== "number" || !Number.isInteger(body.levelNumber)) {
      return jsonErr(req, "invalid_request", "levelNumber required");
    }

    const admin = adminClient();
    const { data, error } = await admin.rpc("api_start_competitive_run", {
      p_student_id: user.id,
      p_topic_code: body.topicCode,
      p_level_number: body.levelNumber,
    });
    if (error) {
      console.error("api_start_competitive_run", error.code ?? "", (error.message ?? "").slice(0, 120));
      const msg = error.message ?? "";
      if (msg.includes("not_found")) return jsonErr(req, "not_found", "Topic or level not found");
      if (msg.includes("forbidden")) return jsonErr(req, "forbidden", "Level locked");
      if (msg.includes("conflict")) return jsonErr(req, "conflict", "Daily run limit reached");
      if (msg.includes("invalid_request")) return jsonErr(req, "invalid_request", "Invalid request");
      return jsonErr(req, "internal", "Start run failed");
    }
    return jsonOk(req, data);
  } catch {
    console.error("start-competitive-run unexpected");
    return jsonErr(req, "internal", "Unexpected error");
  }
});

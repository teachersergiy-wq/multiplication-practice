/** list-competitive-topics — student lists topics for their grade. */
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

    const admin = adminClient();
    const { data, error } = await admin.rpc("api_list_competitive_topics", {
      p_student_id: user.id,
    });
    if (error) {
      console.error("api_list_competitive_topics", error.code ?? "", (error.message ?? "").slice(0, 120));
      return jsonErr(req, "internal", "List topics failed");
    }
    return jsonOk(req, data);
  } catch {
    console.error("list-competitive-topics unexpected");
    return jsonErr(req, "internal", "Unexpected error");
  }
});

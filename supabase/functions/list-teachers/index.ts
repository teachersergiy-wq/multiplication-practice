/** list-teachers — admin only. */
import { handleOptions } from "../_shared/cors.ts";
import { jsonErr, jsonOk } from "../_shared/http.ts";
import { adminClient, userClient } from "../_shared/supabase.ts";

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
    const { data, error } = await admin.rpc("api_admin_list_teachers", {
      p_admin_id: user.id,
    });

    if (error) {
      const msg = error.message ?? "";
      if (msg.includes("forbidden")) {
        return jsonErr(req, "forbidden", "Admin required");
      }
      console.error("api_admin_list_teachers failed");
      return jsonErr(req, "internal", "List failed");
    }

    return jsonOk(req, data as { teachers: unknown[] });
  } catch {
    console.error("list-teachers unexpected error");
    return jsonErr(req, "internal", "Unexpected error");
  }
});

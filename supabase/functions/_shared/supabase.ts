import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export function userClient(req: Request): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const auth = req.headers.get("Authorization") ?? "";
  return createClient(url, anon, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function adminClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return createClient(url, service, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

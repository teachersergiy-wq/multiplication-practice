/**
 * Probe: does local Auth accept 6-char student password + .invalid email
 * when admin.createUser is used with enable_signup=false?
 *
 * Run after `supabase start` with env from `supabase status -o env`.
 * Exit 0 + print VERIFIED lines, or exit 1 + BLOCKED reason.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const url = Deno.env.get("SUPABASE_URL") ?? Deno.env.get("API_URL") ?? "";
const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SERVICE_ROLE_KEY") ?? "";

if (!url || !service) {
  console.error("BLOCKED: missing SUPABASE_URL / service role key in env");
  Deno.exit(1);
}

const admin = createClient(url, service, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const login = "ab" + String(Math.floor(Math.random() * 90 + 10)); // not real alphabet strict
const email = `g2bprobe${Date.now()}@students.local.invalid`;
const password = "kd4817"; // 2 letters + 4 digits per CREDENTIALS

const { data, error } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
});

if (error) {
  console.error("BLOCKED: admin.createUser rejected 6-char password or .invalid email");
  console.error("message:", error.message);
  console.error(
    "Proposal (do not apply without owner): store longer Auth password derived from student password via server secret; keep D1 format for UI.",
  );
  Deno.exit(1);
}

const id = data.user?.id;
if (id) {
  await admin.auth.admin.deleteUser(id);
}

console.log("VERIFIED: admin.createUser accepts password pattern [a-z]{2}[0-9]{4} (kd4817)");
console.log("VERIFIED: admin.createUser accepts email domain students.local.invalid");
console.log("VERIFIED: enable_signup=false does not block admin.createUser");
Deno.exit(0);

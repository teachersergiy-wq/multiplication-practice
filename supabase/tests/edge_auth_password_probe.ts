/**
 * Probe: separate Auth checks for a 6-char student password, a .invalid email,
 * and admin.createUser while enable_signup=false.
 *
 * Writes one line per criterion to $GITHUB_STEP_SUMMARY when that env is set.
 * Exit 1 on BLOCKED or any failed criterion. Exit 0 only when all three succeed
 * and cleanup deleteUser calls succeed.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const url = Deno.env.get("SUPABASE_URL") ?? Deno.env.get("API_URL") ?? "";
const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SERVICE_ROLE_KEY") ?? "";

const lines: string[] = ["### G2b Auth probe"];

function emit(line: string) {
  console.log(line);
  lines.push(line);
}

async function flush(exitCode: number): Promise<never> {
  const path = Deno.env.get("GITHUB_STEP_SUMMARY");
  if (path) {
    await Deno.writeTextFile(path, lines.join("\n") + "\n", { append: true });
  }
  Deno.exit(exitCode);
}

if (!url || !service) {
  emit("BLOCKED: missing SUPABASE_URL / service role key in env");
  await flush(1);
}

const admin = createClient(url, service, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const stamp = Date.now();
const longPassword = "correct-horse-1";
const shortPassword = "kd4817";

async function tryCreate(label: string, email: string, password: string): Promise<boolean> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) {
    emit(`${label}: no (${error.message})`);
    return false;
  }
  const id = data.user?.id;
  if (!id) {
    emit(`${label}: no (createUser returned no user id)`);
    return false;
  }
  const deleted = await admin.auth.admin.deleteUser(id);
  if (deleted.error) {
    emit(`${label}: no (deleteUser failed: ${deleted.error.message})`);
    return false;
  }
  emit(`${label}: yes`);
  return true;
}

const signupOk = await tryCreate(
  "admin.createUser with enable_signup=false (long password, example.com)",
  `g2b-signup-${stamp}@example.com`,
  longPassword,
);
const shortOk = await tryCreate(
  "6-char password accepted",
  `g2b-short-${stamp}@example.com`,
  shortPassword,
);
const invalidOk = await tryCreate(
  ".invalid domain accepted",
  `g2b-invalid-${stamp}@students.local.invalid`,
  longPassword,
);

if (!signupOk || !shortOk || !invalidOk) {
  emit("BLOCKED: one or more Auth probe criteria failed");
  await flush(1);
}

emit("VERIFIED: all three Auth probe criteria passed");
await flush(0);

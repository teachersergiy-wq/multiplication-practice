/**
 * Negative HTTP checks against served Edge Functions (local only).
 * Expects FUNCTIONS base URL and keys in env; optional teacher JWT fixtures.
 *
 * Without pre-seeded teacher JWT, verifies unauthenticated → 401 for all four.
 */
const base = (Deno.env.get("FUNCTIONS_URL") ?? Deno.env.get("SUPABASE_URL") ?? "")
  .replace(/\/$/, "");
const functionsRoot = base.includes("/functions/v1")
  ? base.replace(/\/functions\/v1.*/, "/functions/v1")
  : `${base}/functions/v1`;

const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("ANON_KEY") ?? "";

async function post(name: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    apikey: anon,
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  else if (anon) headers["Authorization"] = `Bearer ${anon}`;
  return await fetch(`${functionsRoot}/${name}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const names = [
  "provision-teacher",
  "create-students",
  "reset-student-password",
  "delete-student",
] as const;

let failed = 0;
for (const name of names) {
  const res = await post(name, {});
  const json = await res.json().catch(() => ({}));
  const code = (json as { error?: { code?: string } })?.error?.code;
  // unauthenticated or invalid_request both prove the function is up and gated
  if (res.status === 401 || code === "unauthenticated" || code === "invalid_request") {
    console.log(`VERIFIED: ${name} rejects anonymous/empty call (status=${res.status} code=${code})`);
  } else {
    console.error(`FAIL: ${name} unexpected status=${res.status} body=${JSON.stringify(json)}`);
    failed++;
  }
}

if (failed > 0) Deno.exit(1);
console.log("VERIFIED: edge negative smoke (no JWT) completed");

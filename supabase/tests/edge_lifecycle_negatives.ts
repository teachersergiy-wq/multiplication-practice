/**
 * Negative HTTP checks against served Edge Functions (local only).
 * Anonymous call must be 401 and/or error.code = unauthenticated.
 * invalid_request is a failure: body validation is not proof of auth.
 *
 * Exit 1 on BLOCKED or any failed function. Writes $GITHUB_STEP_SUMMARY.
 */
const base = (Deno.env.get("FUNCTIONS_URL") ?? Deno.env.get("SUPABASE_URL") ?? "")
  .replace(/\/$/, "");
const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("ANON_KEY") ?? "";

const lines: string[] = ["### Edge negative auth probe"];
const passed: string[] = [];

function emit(line: string) {
  console.log(line);
  lines.push(line);
}

async function flush(exitCode: number): Promise<never> {
  if (passed.length) {
    lines.push("Passed: " + passed.join(", "));
  }
  const path = Deno.env.get("GITHUB_STEP_SUMMARY");
  if (path) {
    await Deno.writeTextFile(path, lines.join("\n") + "\n", { append: true });
  }
  Deno.exit(exitCode);
}

if (!base || !anon) {
  emit("BLOCKED: missing FUNCTIONS_URL/SUPABASE_URL or anon key");
  await flush(1);
}

const functionsRoot = base.includes("/functions/v1")
  ? base.replace(/\/functions\/v1.*/, "/functions/v1")
  : `${base}/functions/v1`;

async function post(name: string): Promise<Response> {
  return await fetch(`${functionsRoot}/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: anon,
      Authorization: `Bearer ${anon}`,
    },
    body: JSON.stringify({}),
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
  let res: Response;
  try {
    res = await post(name);
  } catch (err) {
    emit(`FAIL: ${name} request error ${err instanceof Error ? err.message : String(err)}`);
    failed++;
    continue;
  }
  const json = await res.json().catch(() => ({}));
  const code = (json as { error?: { code?: string } })?.error?.code;
  if (res.status === 401 || code === "unauthenticated") {
    emit(`VERIFIED: ${name} unauthenticated (status=${res.status} code=${code ?? ""})`);
    passed.push(name);
  } else {
    emit(
      `FAIL: ${name} expected 401 or unauthenticated, got status=${res.status} code=${code ?? ""} body=${JSON.stringify(json)}`,
    );
    failed++;
  }
}

if (failed > 0) {
  emit(`BLOCKED: ${failed} negative auth check(s) failed`);
  await flush(1);
}

emit("VERIFIED: edge negative smoke (no JWT) completed");
await flush(0);

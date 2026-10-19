/**
 * Integration test: real HTTP call to provision-teacher Edge Function.
 * Local Supabase only. Run: bash supabase/tests/edge_provision_teacher.sh
 *
 * G2c: public._test_allow_teacher is NOT part of the production migration
 * chain. The shell script recreates a temporary copy for local CI only.
 */
import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const FUNCTIONS_URL =
  Deno.env.get("FUNCTIONS_URL") ?? `${SUPABASE_URL}/functions/v1/provision-teacher`;

Deno.test("provision-teacher rejects missing JWT user (unauthenticated)", async () => {
  const res = await fetch(FUNCTIONS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ANON_KEY}`,
      apikey: ANON_KEY,
    },
    body: JSON.stringify({ fullName: "No Session" }),
  });
  const body = await res.json();
  assertEquals(body.ok, false);
  assertEquals(body.error?.code, "unauthenticated");
});

Deno.test("provision-teacher creates teacher then is idempotent", async () => {
  if (!SERVICE_KEY || !ANON_KEY) {
    throw new Error("missing SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY");
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const email = `g1-edge-${crypto.randomUUID().slice(0, 8)}@test.local`;
  const password = "ab1234";

  // Temporary helper is created by edge_provision_teacher.sh (test-only, not in migrations).
  const { error: allowErr } = await admin.rpc("_test_allow_teacher", { p_email: email });
  if (allowErr) {
    throw new Error(
      `allowlist seed failed: ${allowErr.message}. ` +
        `Run via supabase/tests/edge_provision_teacher.sh so the temporary test helper exists.`,
    );
  }

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createErr || !created.user) {
    throw new Error(`createUser: ${createErr?.message}`);
  }
  const userId = created.user.id;

  try {
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: signed, error: signErr } = await userClient.auth.signInWithPassword({
      email,
      password,
    });
    if (signErr || !signed.session) {
      throw new Error(`signIn: ${signErr?.message}`);
    }
    const token = signed.session.access_token;

    const res1 = await fetch(FUNCTIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        apikey: ANON_KEY,
      },
      body: JSON.stringify({
        fullName: "Edge Teacher",
        schoolName: "Edge School",
        className: "Edge Class",
      }),
    });
    const body1 = await res1.json();
    assertEquals(body1.ok, true, JSON.stringify(body1));
    assertEquals(body1.data.created, true);
    assertEquals(body1.data.profileId, userId);
    assertExists(body1.data.schoolId);
    assertExists(body1.data.classId);

    const res2 = await fetch(FUNCTIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        apikey: ANON_KEY,
      },
      body: JSON.stringify({ fullName: "Second Call Name" }),
    });
    const body2 = await res2.json();
    assertEquals(body2.ok, true, JSON.stringify(body2));
    assertEquals(body2.data.created, false);
    assertEquals(body2.data.profileId, userId);
    assertEquals(body2.data.classId, body1.data.classId);
  } finally {
    await admin.auth.admin.deleteUser(userId);
  }
});

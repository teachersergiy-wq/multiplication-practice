/**
 * provision-teacher — API_CONTRACT §4 / FunctionContracts["provision-teacher"]
 * Role: authenticated (may not have a profile yet).
 * Allowlist: private.allowed_teachers by email (owner-managed).
 */
import { handleOptions } from "../_shared/cors.ts";
import { jsonErr, jsonOk } from "../_shared/http.ts";
import { adminClient, userClient } from "../_shared/supabase.ts";

interface Body {
  fullName?: unknown;
  schoolName?: unknown;
  className?: unknown;
}

function asTrimmedString(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length < 1 || t.length > max) return null;
  return t;
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;

  if (req.method !== "POST") {
    return jsonErr(req, "invalid_request", "POST required");
  }

  try {
    const userSb = userClient(req);
    const {
      data: { user },
      error: userErr,
    } = await userSb.auth.getUser();
    if (userErr || !user) {
      return jsonErr(req, "unauthenticated", "Valid access token required");
    }

    const email = (user.email ?? "").toLowerCase().trim();
    if (!email) {
      return jsonErr(req, "forbidden", "Account has no email");
    }

    const admin = adminClient();

    // R6 allowlist
    const { data: allowed, error: allowErr } = await admin
      .schema("private")
      .from("allowed_teachers")
      .select("email")
      .eq("email", email)
      .maybeSingle();
    if (allowErr) {
      console.error("allowed_teachers lookup failed");
      return jsonErr(req, "internal", "Allowlist lookup failed");
    }
    if (!allowed) {
      return jsonErr(req, "forbidden", "Email is not on the teacher allowlist");
    }

    // Idempotent: existing teacher profile
    const { data: existing, error: profErr } = await admin
      .from("profiles")
      .select("id, role")
      .eq("id", user.id)
      .maybeSingle();
    if (profErr) {
      console.error("profile lookup failed");
      return jsonErr(req, "internal", "Profile lookup failed");
    }

    if (existing) {
      if (existing.role !== "teacher") {
        return jsonErr(req, "forbidden", "Account is not a teacher");
      }
      const { data: link } = await admin
        .from("class_teachers")
        .select("class_id, classes!inner(id, school_id)")
        .eq("teacher_id", user.id)
        .limit(1)
        .maybeSingle();

      const classId = (link as { class_id?: string } | null)?.class_id;
      const schoolId = (
        link as { classes?: { school_id?: string } } | null
      )?.classes?.school_id;

      if (!classId || !schoolId) {
        return jsonErr(req, "internal", "Teacher profile missing class link");
      }

      return jsonOk(req, {
        profileId: user.id,
        schoolId,
        classId,
        created: false,
      });
    }

    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return jsonErr(req, "invalid_request", "JSON body required");
    }

    // Reject unknown top-level fields
    const allowedKeys = new Set(["fullName", "schoolName", "className"]);
    for (const k of Object.keys(body as Record<string, unknown>)) {
      if (!allowedKeys.has(k)) {
        return jsonErr(req, "invalid_request", `Unknown field: ${k}`);
      }
    }

    const fullName = asTrimmedString(body.fullName, 160);
    if (!fullName || fullName.length < 2) {
      return jsonErr(req, "invalid_request", "fullName required (2–160 chars)");
    }
    const schoolName =
      asTrimmedString(body.schoolName, 160) ?? "Моя школа";
    const className = asTrimmedString(body.className, 80) ?? "Мій клас";

    const nick =
      "Учитель-" + user.id.replaceAll("-", "").slice(0, 8);

    const { error: insProfErr } = await admin.from("profiles").insert({
      id: user.id,
      role: "teacher",
      full_name: fullName,
      generated_nickname: nick,
      student_login_code: null,
    });
    if (insProfErr) {
      console.error("profile insert failed");
      return jsonErr(req, "internal", "Failed to create profile");
    }

    const { data: school, error: schoolErr } = await admin
      .from("schools")
      .insert({ name: schoolName })
      .select("id")
      .single();
    if (schoolErr || !school) {
      console.error("school insert failed");
      return jsonErr(req, "internal", "Failed to create school");
    }

    const { data: cls, error: classErr } = await admin
      .from("classes")
      .insert({ school_id: school.id, name: className })
      .select("id")
      .single();
    if (classErr || !cls) {
      console.error("class insert failed");
      return jsonErr(req, "internal", "Failed to create class");
    }

    const { error: linkErr } = await admin.from("class_teachers").insert({
      class_id: cls.id,
      teacher_id: user.id,
    });
    if (linkErr) {
      console.error("class_teachers insert failed");
      return jsonErr(req, "internal", "Failed to link teacher to class");
    }

    return jsonOk(req, {
      profileId: user.id,
      schoolId: school.id,
      classId: cls.id,
      created: true,
    });
  } catch (e) {
    console.error("provision-teacher unexpected error");
    return jsonErr(req, "internal", "Unexpected error");
  }
});

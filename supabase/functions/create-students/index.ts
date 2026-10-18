/**
 * create-students — teacher only; own class; credentials per API_CONTRACT.
 * Auth is outside DB transactions → full compensation on any failure:
 * delete Auth users and DB rows created in this invocation; never return partial success.
 */
import { handleOptions } from "../_shared/cors.ts";
import { jsonErr, jsonOk } from "../_shared/http.ts";
import { adminClient, userClient } from "../_shared/supabase.ts";
import { requireTeacher, teacherOwnsClass } from "../_shared/authz.ts";
import {
  generateLogin,
  generatePassword,
  getStudentEmailDomain,
  studentEmail,
} from "../_shared/credentials.ts";

interface Body {
  classId?: unknown;
  students?: unknown;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (req.method !== "POST") return jsonErr(req, "invalid_request", "POST required");

  const createdAuthIds: string[] = [];

  const compensate = async (admin: ReturnType<typeof adminClient>) => {
    for (const id of createdAuthIds) {
      try {
        await admin.from("class_students").delete().eq("student_id", id);
        await admin.from("profiles").delete().eq("id", id);
        await admin.auth.admin.deleteUser(id);
      } catch {
        console.error("compensation step failed");
      }
    }
  };

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
    const teacher = await requireTeacher(admin, user.id);
    if (!teacher.ok) return jsonErr(req, teacher.code, teacher.message);

    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return jsonErr(req, "invalid_request", "JSON body required");
    }

    const allowedKeys = new Set(["classId", "students"]);
    for (const k of Object.keys(body as Record<string, unknown>)) {
      if (!allowedKeys.has(k)) {
        return jsonErr(req, "invalid_request", `Unknown field: ${k}`);
      }
    }

    if (typeof body.classId !== "string" || !UUID_RE.test(body.classId)) {
      return jsonErr(req, "invalid_request", "classId must be a UUID");
    }
    if (!Array.isArray(body.students) || body.students.length < 1 || body.students.length > 40) {
      return jsonErr(req, "invalid_request", "students: 1–40 items required");
    }

    const names: string[] = [];
    for (const s of body.students) {
      if (!s || typeof s !== "object" || Array.isArray(s)) {
        return jsonErr(req, "invalid_request", "each student must be an object");
      }
      const rec = s as Record<string, unknown>;
      if (Object.keys(rec).some((k) => k !== "fullName")) {
        return jsonErr(req, "invalid_request", "student fields: only fullName");
      }
      if (typeof rec.fullName !== "string") {
        return jsonErr(req, "invalid_request", "fullName required");
      }
      const n = rec.fullName.trim();
      if (n.length < 1 || n.length > 160) {
        return jsonErr(req, "invalid_request", "fullName length 1–160");
      }
      names.push(n);
    }

    const classId = body.classId;
    if (!(await teacherOwnsClass(admin, user.id, classId))) {
      return jsonErr(req, "not_found", "Class not found");
    }

    const { count, error: cntErr } = await admin
      .from("class_students")
      .select("student_id", { count: "exact", head: true })
      .eq("class_id", classId);
    if (cntErr) return jsonErr(req, "internal", "Class size lookup failed");
    if ((count ?? 0) + names.length > 200) {
      return jsonErr(req, "invalid_request", "Class would exceed 200 students");
    }

    let domain: string;
    try {
      domain = getStudentEmailDomain();
    } catch {
      return jsonErr(req, "internal", "STUDENT_EMAIL_DOMAIN not configured");
    }

    const created: {
      studentId: string;
      fullName: string;
      login: string;
      password: string;
    }[] = [];

    for (const fullName of names) {
      let login = "";
      let email = "";
      let password = "";
      let authId = "";

      for (let attempt = 0; attempt < 12; attempt++) {
        login = generateLogin();
        email = studentEmail(login, domain);
        password = generatePassword();

        const { data: existingLogin } = await admin
          .from("profiles")
          .select("id")
          .eq("student_login_code", login)
          .maybeSingle();
        if (existingLogin) continue;

        const { data: authData, error: authErr } = await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { role: "student", login },
        });
        if (authErr || !authData.user) continue;
        authId = authData.user.id;
        createdAuthIds.push(authId);
        break;
      }

      if (!authId) {
        await compensate(admin);
        return jsonErr(req, "internal", "Failed to allocate unique student credentials");
      }

      const nick = "Учень-" + login;
      const { error: rpcErr } = await admin.rpc("create_student_records", {
        p_student_id: authId,
        p_full_name: fullName,
        p_login_code: login,
        p_class_id: classId,
        p_nickname: nick,
      });

      if (rpcErr) {
        await compensate(admin);
        console.error("create_student_records failed");
        return jsonErr(req, "internal", "Failed to create student records");
      }

      created.push({ studentId: authId, fullName, login, password });
    }

    return jsonOk(req, { students: created });
  } catch {
    try {
      await compensate(adminClient());
    } catch {
      /* ignore */
    }
    console.error("create-students unexpected error");
    return jsonErr(req, "internal", "Unexpected error");
  }
});

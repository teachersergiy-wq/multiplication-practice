/** delete-student — teacher, student in own class; cascades history via FK; removes Auth user. */
import { handleOptions } from "../_shared/cors.ts";
import { jsonErr, jsonOk } from "../_shared/http.ts";
import { adminClient, userClient } from "../_shared/supabase.ts";
import { requireTeacher, teacherOwnsStudent } from "../_shared/authz.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    const teacher = await requireTeacher(admin, user.id);
    if (!teacher.ok) return jsonErr(req, teacher.code, teacher.message);

    let body: { studentId?: unknown };
    try {
      body = await req.json();
    } catch {
      return jsonErr(req, "invalid_request", "JSON body required");
    }

    for (const k of Object.keys(body as Record<string, unknown>)) {
      if (k !== "studentId") {
        return jsonErr(req, "invalid_request", `Unknown field: ${k}`);
      }
    }
    if (typeof body.studentId !== "string" || !UUID_RE.test(body.studentId)) {
      return jsonErr(req, "invalid_request", "studentId must be a UUID");
    }

    const owned = await teacherOwnsStudent(admin, user.id, body.studentId);
    if (!owned) return jsonErr(req, "not_found", "Student not found");

    // DB first (profiles PK = auth user id; class_students / attempts cascade)
    const { error: delProf } = await admin.from("profiles").delete().eq("id", body.studentId);
    if (delProf) {
      console.error("profile delete failed");
      return jsonErr(req, "internal", "Failed to delete student profile");
    }

    const { error: delAuth } = await admin.auth.admin.deleteUser(body.studentId);
    if (delAuth) {
      // Profile already gone; report internal so operator can clean Auth manually
      console.error("auth deleteUser failed after profile delete");
      return jsonErr(req, "internal", "Student profile removed but Auth cleanup failed");
    }

    return jsonOk(req, { deleted: true as const });
  } catch {
    console.error("delete-student unexpected error");
    return jsonErr(req, "internal", "Unexpected error");
  }
});

/**
 * set-class-subject — teacher owns class; add subject+grade or change grade if no assignments.
 */
import { handleOptions } from "../_shared/cors.ts";
import { jsonErr, jsonOk } from "../_shared/http.ts";
import { adminClient, userClient } from "../_shared/supabase.ts";
import { requireTeacher } from "../_shared/authz.ts";

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

    let body: {
      classId?: unknown;
      subjectId?: unknown;
      gradeLevel?: unknown;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonErr(req, "invalid_request", "JSON body required");
    }

    for (const k of Object.keys(body as Record<string, unknown>)) {
      if (k !== "classId" && k !== "subjectId" && k !== "gradeLevel") {
        return jsonErr(req, "invalid_request", `Unknown field: ${k}`);
      }
    }

    if (typeof body.classId !== "string" || !UUID_RE.test(body.classId)) {
      return jsonErr(req, "invalid_request", "classId must be a UUID");
    }
    if (typeof body.subjectId !== "string" || !UUID_RE.test(body.subjectId)) {
      return jsonErr(req, "invalid_request", "subjectId must be a UUID");
    }
    if (
      typeof body.gradeLevel !== "number" ||
      !Number.isInteger(body.gradeLevel) ||
      body.gradeLevel < 1 ||
      body.gradeLevel > 12
    ) {
      return jsonErr(req, "invalid_request", "gradeLevel must be integer 1–12");
    }

    const { data, error } = await admin.rpc("api_set_class_subject", {
      p_teacher_id: user.id,
      p_class_id: body.classId,
      p_subject_id: body.subjectId,
      p_grade_level: body.gradeLevel,
    });

    if (error) {
      const msg = error.message ?? "";
      if (msg.includes("not_found")) return jsonErr(req, "not_found", "Class or subject not found");
      if (msg.includes("conflict")) {
        return jsonErr(
          req,
          "conflict",
          "Cannot change gradeLevel while assignments exist for this subject",
        );
      }
      if (msg.includes("invalid_request")) {
        return jsonErr(req, "invalid_request", msg.replace(/^.*invalid_request:\s*/i, "") || "Invalid request");
      }
      console.error("api_set_class_subject failed");
      return jsonErr(req, "internal", "Set class subject failed");
    }

    return jsonOk(req, data as {
      classId: string;
      subjectId: string;
      gradeLevel: number;
      created: boolean;
    });
  } catch {
    console.error("set-class-subject unexpected error");
    return jsonErr(req, "internal", "Unexpected error");
  }
});

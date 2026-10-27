/**
 * generate-multiplication-test — teacher only; draft numeric quiz from level config.
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
      subjectId?: unknown;
      gradeLevel?: unknown;
      levelNumber?: unknown;
      mode?: unknown;
      title?: unknown;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonErr(req, "invalid_request", "JSON body required");
    }

    for (const k of Object.keys(body as Record<string, unknown>)) {
      if (
        k !== "subjectId" &&
        k !== "gradeLevel" &&
        k !== "levelNumber" &&
        k !== "mode" &&
        k !== "title"
      ) {
        return jsonErr(req, "invalid_request", `Unknown field: ${k}`);
      }
    }

    if (typeof body.subjectId !== "string" || !UUID_RE.test(body.subjectId)) {
      return jsonErr(req, "invalid_request", "subjectId must be a UUID");
    }
    if (
      typeof body.gradeLevel !== "number" ||
      !Number.isInteger(body.gradeLevel) ||
      body.gradeLevel < 1 ||
      body.gradeLevel > 11
    ) {
      return jsonErr(req, "invalid_request", "gradeLevel must be integer 1–11");
    }
    if (
      typeof body.levelNumber !== "number" ||
      !Number.isInteger(body.levelNumber) ||
      body.levelNumber < 1 ||
      body.levelNumber > 5
    ) {
      return jsonErr(req, "invalid_request", "levelNumber must be integer 1–5");
    }
    if (body.mode !== "practice" && body.mode !== "graded") {
      return jsonErr(req, "invalid_request", "mode must be practice or graded");
    }

    let title: string | null = null;
    if (body.title !== undefined && body.title !== null) {
      if (typeof body.title !== "string") {
        return jsonErr(req, "invalid_request", "title must be a string");
      }
      title = body.title.trim();
      if (title.length < 1 || title.length > 120) {
        return jsonErr(req, "invalid_request", "title length 1–120");
      }
    }

    const { data, error } = await admin.rpc("api_generate_multiplication_test", {
      p_teacher_id: user.id,
      p_subject_id: body.subjectId,
      p_grade_level: body.gradeLevel,
      p_level_number: body.levelNumber,
      p_mode: body.mode,
      p_title: title,
    });

    if (error) {
      // Log code + short message prefix only — not full bodies.
      console.error(
        "api_generate_multiplication_test",
        error.code ?? "",
        (error.message ?? "").slice(0, 120),
      );
      const msg = error.message ?? "";
      if (msg.includes("not_found")) {
        return jsonErr(req, "not_found", "Subject or config not found");
      }
      if (msg.includes("conflict")) {
        return jsonErr(req, "conflict", "Daily generate limit reached");
      }
      if (msg.includes("invalid_request")) {
        return jsonErr(
          req,
          "invalid_request",
          msg.replace(/^.*invalid_request:\s*/i, "") || "Invalid request",
        );
      }
      return jsonErr(req, "internal", "Generate failed");
    }

    return jsonOk(req, data as {
      templateId: string;
      title: string;
      questionCount: number;
      configGradeLevel: number;
      settings: { passPercent: number; maxErrors: number };
    });
  } catch {
    console.error("generate-multiplication-test unexpected error");
    return jsonErr(req, "internal", "Unexpected error");
  }
});

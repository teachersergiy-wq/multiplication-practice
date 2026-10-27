/**
 * generate-multiplication-bank — teacher; BIG table pool draft.
 * Grade level 1–11 (D8).
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
      mode?: unknown;
      title?: unknown;
      levelCounts?: unknown;
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
        k !== "mode" &&
        k !== "title" &&
        k !== "levelCounts"
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

    let levelCounts: number[] | null = null;
    if (body.levelCounts !== undefined && body.levelCounts !== null) {
      if (!Array.isArray(body.levelCounts) || body.levelCounts.length !== 5) {
        return jsonErr(req, "invalid_request", "levelCounts must be 5 integers");
      }
      levelCounts = [];
      for (const n of body.levelCounts) {
        if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
          return jsonErr(req, "invalid_request", "levelCounts must be integers >= 0");
        }
        levelCounts.push(n);
      }
    }

    const { data, error } = await admin.rpc("api_generate_multiplication_bank", {
      p_teacher_id: user.id,
      p_subject_id: body.subjectId,
      p_grade_level: body.gradeLevel,
      p_mode: body.mode,
      p_title: title,
      p_level_counts: levelCounts,
    });

    if (error) {
      console.error(
        "api_generate_multiplication_bank",
        error.code ?? "",
        (error.message ?? "").slice(0, 120),
      );
      const msg = error.message ?? "";
      if (msg.includes("not_found")) return jsonErr(req, "not_found", "Subject not found");
      if (msg.includes("conflict")) {
        return jsonErr(req, "conflict", "Daily generate limit reached");
      }
      if (msg.includes("invalid_request")) {
        return jsonErr(req, "invalid_request", "Invalid request");
      }
      return jsonErr(req, "internal", "Generate bank failed");
    }

    return jsonOk(req, data as {
      templateId: string;
      title: string;
      bankSize: number;
      bankByLevel: number[];
      settings: unknown;
    });
  } catch {
    console.error("generate-multiplication-bank unexpected error");
    return jsonErr(req, "internal", "Unexpected error");
  }
});

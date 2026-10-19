/**
 * get-assessment-draft — teacher owner only; returns authored questions with keys.
 */
import { handleOptions } from "../_shared/cors.ts";
import { jsonErr, jsonOk } from "../_shared/http.ts";
import { adminClient, userClient } from "../_shared/supabase.ts";
import { requireTeacher } from "../_shared/authz.ts";
import { reconstructAuthored, type QuestionType } from "../_shared/questions.ts";

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

    let body: { templateId?: unknown };
    try {
      body = (await req.json()) as { templateId?: unknown };
    } catch {
      return jsonErr(req, "invalid_request", "JSON body required");
    }
    for (const k of Object.keys(body as Record<string, unknown>)) {
      if (k !== "templateId") return jsonErr(req, "invalid_request", `Unknown field: ${k}`);
    }
    if (typeof body.templateId !== "string" || !UUID_RE.test(body.templateId)) {
      return jsonErr(req, "invalid_request", "templateId must be a UUID");
    }

    const { data, error } = await admin.rpc("api_get_assessment_draft", {
      p_template_id: body.templateId,
      p_teacher_id: user.id,
    });
    if (error) {
      const msg = error.message ?? "";
      if (msg.includes("not_found")) return jsonErr(req, "not_found", "Template not found");
      console.error("api_get_assessment_draft failed");
      return jsonErr(req, "internal", "Draft lookup failed");
    }

    const raw = data as {
      template: {
        id: string;
        title: string;
        subjectId: string;
        gradeLevel: number;
        mode: string;
        status: string;
        settings: Record<string, unknown>;
      };
      questions: Array<{
        id: string;
        position: number;
        type: QuestionType;
        promptText: string;
        points: number;
        timeLimitSeconds: number | null;
        choices: unknown[];
        answerKey: Record<string, unknown> | null;
      }>;
    };

    const questions = (raw.questions ?? []).map((q) => {
      const authored = reconstructAuthored(
        q.type,
        q.promptText,
        Number(q.points),
        q.timeLimitSeconds,
        q.choices ?? [],
        q.answerKey,
      );
      return { ...authored, id: q.id, position: q.position };
    });

    return jsonOk(req, {
      template: {
        id: raw.template.id,
        title: raw.template.title,
        subjectId: raw.template.subjectId,
        gradeLevel: raw.template.gradeLevel,
        mode: raw.template.mode,
        status: raw.template.status,
        settings: raw.template.settings ?? {},
      },
      questions,
    });
  } catch {
    console.error("get-assessment-draft unexpected error");
    return jsonErr(req, "internal", "Unexpected error");
  }
});

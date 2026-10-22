/**
 * upsert-question — teacher, draft template; atomic public row + private key.
 * Answer key never returned to the client.
 * SQL also enforces owner + draft (G3b); Edge check is defense in depth.
 */
import { handleOptions } from "../_shared/cors.ts";
import { jsonErr, jsonOk } from "../_shared/http.ts";
import { adminClient, userClient } from "../_shared/supabase.ts";
import { requireTeacher } from "../_shared/authz.ts";
import { LIMITS, splitAuthoredQuestion } from "../_shared/questions.ts";

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

    let body: { templateId?: unknown; questionId?: unknown; question?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonErr(req, "invalid_request", "JSON body required");
    }
    const allowed = new Set(["templateId", "questionId", "question"]);
    for (const k of Object.keys(body as Record<string, unknown>)) {
      if (!allowed.has(k)) return jsonErr(req, "invalid_request", `Unknown field: ${k}`);
    }

    if (typeof body.templateId !== "string" || !UUID_RE.test(body.templateId)) {
      return jsonErr(req, "invalid_request", "templateId must be a UUID");
    }
    let questionId: string | null = null;
    if (body.questionId !== undefined && body.questionId !== null) {
      if (typeof body.questionId !== "string" || !UUID_RE.test(body.questionId)) {
        return jsonErr(req, "invalid_request", "questionId must be a UUID");
      }
      questionId = body.questionId;
    }

    let split;
    try {
      split = splitAuthoredQuestion(body.question);
    } catch (e) {
      return jsonErr(req, "invalid_request", e instanceof Error ? e.message : "Invalid question");
    }

    const { data: tpl, error: tplErr } = await admin
      .from("assessment_templates")
      .select("id, teacher_id, status")
      .eq("id", body.templateId)
      .maybeSingle();
    if (tplErr) return jsonErr(req, "internal", "Template lookup failed");
    if (!tpl || tpl.teacher_id !== user.id) {
      return jsonErr(req, "not_found", "Template not found");
    }
    if (tpl.status !== "draft") {
      return jsonErr(req, "conflict", "Template is not a draft");
    }

    let position = 1;
    if (questionId) {
      const { data: existing, error: exErr } = await admin
        .from("assessment_questions")
        .select("id, position, template_id")
        .eq("id", questionId)
        .maybeSingle();
      if (exErr) return jsonErr(req, "internal", "Question lookup failed");
      if (!existing || existing.template_id !== body.templateId) {
        return jsonErr(req, "not_found", "Question not found");
      }
      position = existing.position as number;
    } else {
      const { count, error: cntErr } = await admin
        .from("assessment_questions")
        .select("id", { count: "exact", head: true })
        .eq("template_id", body.templateId);
      if (cntErr) return jsonErr(req, "internal", "Question count failed");
      if ((count ?? 0) >= LIMITS.questionsPerTemplate.max) {
        return jsonErr(req, "invalid_request", "Template has maximum questions");
      }
      position = (count ?? 0) + 1;
    }

    const { data: newId, error: saveErr } = await admin.rpc("api_save_question_with_key", {
      p_template_id: body.templateId,
      p_teacher_id: user.id,
      p_question_id: questionId,
      p_position: position,
      p_question_type: split.questionType,
      p_prompt: split.prompt,
      p_choices: split.choices,
      p_points: split.points,
      p_time_limit_seconds: split.timeLimitSeconds,
      p_answer_key: split.answerKey,
    });

    if (saveErr) {
      const msg = saveErr.message ?? "";
      if (msg.includes("invalid_request")) {
        return jsonErr(req, "invalid_request", msg.replace(/^invalid_request:\s*/i, ""));
      }
      if (msg.includes("conflict")) {
        return jsonErr(req, "conflict", "Template is not a draft");
      }
      if (msg.includes("not_found") || msg.includes("not found")) {
        return jsonErr(req, "not_found", "Question not found");
      }
      console.error("api_save_question_with_key failed");
      return jsonErr(req, "internal", "Failed to save question");
    }

    // Never return the answer key
    return jsonOk(req, { questionId: newId as string });
  } catch {
    console.error("upsert-question unexpected error");
    return jsonErr(req, "internal", "Unexpected error");
  }
});

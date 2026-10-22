function failureReason(error) {
  if (error?.code === "23505") return "duplicate";
  if (error?.code === "23503") return "referenced";
  if (error?.code === "42501") return "permission";
  return "database";
}

export async function publishDraft(client, templateId, teacherId, mode, invoke) {
  try {
    const { data, error } = await client.from("assessment_templates")
      .update({ mode })
      .eq("id", templateId)
      .eq("teacher_id", teacherId)
      .eq("status", "draft")
      .select("id")
      .maybeSingle();
    if (error) return { ok: false, reason: failureReason(error) };
    if (!data) return { ok: false, reason: "not_found" };
    if (!invoke) return { ok: false, reason: "database" };
    return await invoke(client, "publish-assessment", { templateId });
  } catch {
    return { ok: false, reason: "database" };
  }
}

export async function createAssignment(client, values) {
  try {
    const { data, error } = await client.from("assessment_assignments")
      .insert(values)
      .select("id")
      .maybeSingle();
    if (error) return { ok: false, reason: failureReason(error) };
    if (!data?.id) return { ok: false, reason: "not_found" };
    return { ok: true, id: data.id };
  } catch {
    return { ok: false, reason: "database" };
  }
}

export async function updateAssignmentWindow(client, assignmentId, values) {
  try {
    const { data, error } = await client.from("assessment_assignments")
      .update({ opens_at: values.opensAt, closes_at: values.closesAt, allow_retries: values.allowRetries })
      .eq("id", assignmentId)
      .select("id")
      .maybeSingle();
    if (error) return { ok: false, reason: failureReason(error) };
    if (!data?.id) return { ok: false, reason: "not_found" };
    return { ok: true, id: data.id };
  } catch {
    return { ok: false, reason: "database" };
  }
}

export async function deleteAssignment(client, assignmentId) {
  try {
    const { data, error } = await client.from("assessment_assignments")
      .delete()
      .eq("id", assignmentId)
      .select("id")
      .maybeSingle();
    if (error) return { ok: false, reason: failureReason(error) };
    if (!data?.id) return { ok: false, reason: "not_found" };
    return { ok: true, id: data.id };
  } catch {
    return { ok: false, reason: "database" };
  }
}

export function toDateTimeLocal(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function fromDateTimeLocal(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function isValidAssignmentWindow(opensAt, closesAt) {
  if (!opensAt || !closesAt) return true;
  return new Date(closesAt).getTime() > new Date(opensAt).getTime();
}

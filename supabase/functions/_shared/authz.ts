import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export async function requireTeacher(
  admin: SupabaseClient,
  userId: string,
): Promise<{ ok: true } | { ok: false; code: "forbidden" | "internal"; message: string }> {
  const { data, error } = await admin
    .from("profiles")
    .select("id, role")
    .eq("id", userId)
    .maybeSingle();
  if (error) return { ok: false, code: "internal", message: "Profile lookup failed" };
  if (!data || data.role !== "teacher") {
    return { ok: false, code: "forbidden", message: "Teacher profile required" };
  }
  return { ok: true };
}

export async function teacherOwnsClass(
  admin: SupabaseClient,
  teacherId: string,
  classId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("class_teachers")
    .select("class_id")
    .eq("class_id", classId)
    .eq("teacher_id", teacherId)
    .maybeSingle();
  if (error) return false;
  return !!data;
}

/** Two-step lookup: no FK between class_students and class_teachers for PostgREST embed. */
export async function teacherOwnsStudent(
  admin: SupabaseClient,
  teacherId: string,
  studentId: string,
): Promise<{ classId: string } | null> {
  const { data: link, error: e1 } = await admin
    .from("class_students")
    .select("class_id")
    .eq("student_id", studentId)
    .maybeSingle();
  if (e1 || !link?.class_id) return null;

  const owns = await teacherOwnsClass(admin, teacherId, link.class_id as string);
  if (!owns) return null;
  return { classId: link.class_id as string };
}

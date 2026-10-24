export function validateClassInput(name, gradeLevel, subjectId) {
  const trimmedName = typeof name === "string" ? name.trim() : "";
  if (trimmedName.length < 1 || trimmedName.length > 80) return { ok: false, reason: "name" };
  if (!Number.isInteger(Number(gradeLevel)) || Number(gradeLevel) < 1 || Number(gradeLevel) > 12) {
    return { ok: false, reason: "grade" };
  }
  if (typeof subjectId !== "string" || !subjectId) return { ok: false, reason: "subject" };
  return { ok: true, name: trimmedName, gradeLevel: Number(gradeLevel), subjectId };
}

export function classFunctionMessage(code, action) {
  if (code === "invalid_request") return "Перевірте назву класу, предмет і рівень від 1 до 11.";
  if (code === "not_found") return "Предмет або клас не знайдено. Оновіть сторінку й спробуйте ще раз.";
  if (code === "forbidden") return "Немає доступу до цього класу або предмета.";
  if (code === "internal") return "Не вдалося зберегти клас через тимчасову помилку. Перевірте з’єднання й спробуйте ще раз.";
  if (code === "unauthenticated") return "Сеанс завершився. Увійдіть знову.";
  if (code === "conflict") {
    return action === "configure"
      ? "Рівень предмета не можна змінити, бо для цього класу вже є призначення. Створіть окремий клас для іншого рівня."
      : "Клас із такою назвою вже існує в школі.";
  }
  return "Не вдалося зберегти клас. Перевірте з’єднання й спробуйте ще раз.";
}

export function classSelectionAfterRefresh(rows, currentId, preferredId = "") {
  const targetId = preferredId || currentId;
  return targetId && rows.some((row) => row.id === targetId) ? targetId : rows[0]?.id || "";
}

export function assignmentNoCompatibleClassMessage(gradeLevel, subjectName) {
  return `Немає вашого класу ${gradeLevel} рівня з предметом «${subjectName}».`;
}

export function assignmentClassAvailability(compatibleClassCount, availableClassCount) {
  if (availableClassCount > 0) return "available";
  return compatibleClassCount > 0 ? "already-assigned" : "none-compatible";
}

export function buildClassRequest(mode, values) {
  if (mode === "create") {
    return {
      name: "create-class",
      body: { name: values.name.trim(), subjectId: values.subjectId, gradeLevel: Number(values.gradeLevel) },
    };
  }
  return {
    name: "set-class-subject",
    body: { classId: values.classId, subjectId: values.subjectId, gradeLevel: Number(values.gradeLevel) },
  };
}

export async function saveClass(mode, values, invoke) {
  const request = buildClassRequest(mode, values);
  return invoke(request.name, request.body);
}

export const CLASS_LIST_CHANGED_EVENT = "learning-studio:classes-changed";

export function announceClassListChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CLASS_LIST_CHANGED_EVENT));
}

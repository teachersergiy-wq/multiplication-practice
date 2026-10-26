export function buildAddTeacherRequest({ email, fullName }) {
  return { email: String(email ?? "").trim().toLowerCase(), fullName: String(fullName ?? "").trim() };
}

export function teacherAdminErrorMessage(code) {
  if (code === "invalid_request") return "Перевірте електронну пошту та ПІБ.";
  if (code === "forbidden") return "У вас немає прав адміністратора для цієї дії.";
  if (code === "conflict") return "Такий обліковий запис уже існує або дію не можна виконати.";
  if (code === "not_found") return "Обліковий запис учителя не знайдено.";
  return null;
}

export function createTemporaryPasswordSlot() {
  let secret = null;
  return {
    set(value) { secret = typeof value === "string" ? value : null; },
    read() { return secret; },
    clear() { secret = null; },
  };
}

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { FunctionContracts } from "../../contracts/api";
import type { supabase } from "../lib/supabase";
import { apiErrorMessage, invokeFunction } from "../lib/function-api";
import { buildAddTeacherRequest, buildResetTeacherPasswordRequest, buildSetTeacherActiveRequest, createTemporaryPasswordSlot, teacherAdminErrorMessage } from "./teacher-admin.js";

type Client = NonNullable<typeof supabase>;
type Teacher = FunctionContracts["list-teachers"]["data"]["teachers"][number];
type Identity = { userId: string; displayName: string; email: string; signOut: () => Promise<void> };

export function TeacherAccountMenu({ client, identity }: { client: Client; identity: Identity }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [adminAccess, setAdminAccess] = useState<boolean | null>(null);
  const [view, setView] = useState<"menu" | "teachers" | "password">("menu");
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordMessage, setPasswordMessage] = useState("");
  const [temporaryPassword, setTemporaryPassword] = useState<string | null>(null);
  const [temporaryPasswordTitle, setTemporaryPasswordTitle] = useState("");
  const [copyMessage, setCopyMessage] = useState("");
  const passwordSlot = useRef(createTemporaryPasswordSlot());

  async function loadTeachers() {
    setError("");
    const result = await invokeFunction(client, "list-teachers", {});
    if (result.ok) {
      setTeachers(result.data.teachers);
      setAdminAccess(true);
      return true;
    }
    if (result.error.code === "forbidden") {
      setAdminAccess(false);
      return false;
    }
    setAdminAccess(true);
    setError(teacherAdminErrorMessage(result.error.code) ?? apiErrorMessage(result.error.code));
    return false;
  }

  useEffect(() => {
    let active = true;
    void invokeFunction(client, "list-teachers", {}).then((result) => {
      if (!active) return;
      if (result.ok) {
        setTeachers(result.data.teachers);
        setAdminAccess(true);
      } else if (result.error.code === "forbidden") setAdminAccess(false);
      else {
        // A transient error is not evidence that the caller is forbidden; retry from the screen.
        setAdminAccess(true);
      }
    });
    return () => { active = false; };
  }, [client]);

  function closeTemporaryPassword() {
    passwordSlot.current.clear();
    setTemporaryPassword(null);
    setTemporaryPasswordTitle("");
    setCopyMessage("");
  }

  function showTemporaryPassword(password: string, title: string) {
    passwordSlot.current.set(password);
    setTemporaryPassword(passwordSlot.current.read());
    setTemporaryPasswordTitle(title);
    setCopyMessage("");
  }

  async function addTeacher(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const request = buildAddTeacherRequest({ email, fullName });
    setBusy(true); setError(""); setNotice("");
    const result = await invokeFunction(client, "add-teacher", request);
    setBusy(false);
    if (!result.ok) {
      setError(teacherAdminErrorMessage(result.error.code) ?? apiErrorMessage(result.error.code));
      return;
    }
    setTeachers((current) => [result.data.teacher, ...current.filter((item) => item.userId !== result.data.teacher.userId)]);
    setEmail(""); setFullName("");
    showTemporaryPassword(result.data.temporaryPassword, `Тимчасовий пароль для ${result.data.teacher.email}`);
  }

  async function resetPassword(teacher: Teacher) {
    if (busy || teacher.isAdmin || teacher.userId === identity.userId) return;
    if (!window.confirm(`Створити новий тимчасовий пароль для ${teacher.email}?`)) return;
    setBusy(true); setError(""); setNotice("");
    const result = await invokeFunction(client, "reset-teacher-password", buildResetTeacherPasswordRequest(teacher.userId));
    setBusy(false);
    if (!result.ok) {
      setError(teacherAdminErrorMessage(result.error.code) ?? apiErrorMessage(result.error.code));
      return;
    }
    showTemporaryPassword(result.data.temporaryPassword, `Новий тимчасовий пароль для ${teacher.email}`);
  }

  async function toggleTeacher(teacher: Teacher) {
    if (busy || teacher.isAdmin || teacher.userId === identity.userId) return;
    const active = !teacher.active;
    const action = active ? "увімкнути" : "вимкнути";
    if (!window.confirm(`Ви справді хочете ${action} обліковий запис ${teacher.email}?`)) return;
    setBusy(true); setError(""); setNotice("");
    const result = await invokeFunction(client, "set-teacher-active", buildSetTeacherActiveRequest(teacher.userId, active));
    setBusy(false);
    if (!result.ok) {
      setError(teacherAdminErrorMessage(result.error.code) ?? apiErrorMessage(result.error.code));
      return;
    }
    setTeachers((current) => current.map((item) => item.userId === teacher.userId ? result.data.teacher : item));
    setNotice(active ? "Обліковий запис учителя увімкнено." : "Обліковий запис учителя вимкнено.");
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !newPassword) return;
    if (newPassword !== confirmPassword) {
      setPasswordMessage("Паролі не збігаються.");
      return;
    }
    setBusy(true); setPasswordMessage("");
    const { error: updateError } = await client.auth.updateUser({ password: newPassword });
    setBusy(false);
    setNewPassword(""); setConfirmPassword("");
    if (updateError) {
      setPasswordMessage("Не вдалося змінити пароль. Перевірте вимоги до пароля й з’єднання.");
      return;
    }
    setPasswordMessage("Пароль змінено.");
  }

  async function copyTemporaryPassword() {
    if (!temporaryPassword) return;
    try {
      await navigator.clipboard.writeText(temporaryPassword);
      setCopyMessage("Пароль скопійовано.");
    } catch {
      setCopyMessage("Копіювання недоступне в цьому браузері. Виділіть пароль і скопіюйте його вручну.");
    }
  }

  return <div className="teacher-account-menu">
    <button className="profile-button" aria-label={`Профіль ${identity.displayName}`} aria-expanded={menuOpen} onClick={() => { setMenuOpen((open) => !open); setView("menu"); }}>
      <span>{identity.displayName.slice(0, 1).toLocaleUpperCase("uk-UA")}</span><span className="profile-name">{identity.displayName}</span><span aria-hidden="true">⌄</span>
    </button>
    {menuOpen && <div className="teacher-profile-popover">
      {view === "menu" ? <>
        <strong>{identity.displayName}</strong><small>{identity.email}</small>
        <button type="button" onClick={() => { setView("password"); setPasswordMessage(""); }}>Змінити пароль</button>
        <p>Якщо ви отримали тимчасовий пароль, змініть його після першого входу.</p>
        {adminAccess !== false && <button type="button" onClick={() => { setView("teachers"); setError(""); void loadTeachers(); }}>Вчителі</button>}
        <button type="button" onClick={() => void identity.signOut()}>Вийти</button>
      </> : view === "password" ? <>
        <div className="teacher-admin-heading"><div><small>ПРОФІЛЬ</small><h2>Змінити пароль</h2></div><button type="button" className="teacher-admin-close" aria-label="Назад до профілю" onClick={() => setView("menu")}>×</button></div>
        <p className="teacher-admin-hint">Якщо пароль був тимчасовим, змініть його після першого входу.</p>
        <form className="teacher-admin-form" onSubmit={(event) => void changePassword(event)}>
          <label>НОВИЙ ПАРОЛЬ<input type="password" autoComplete="new-password" required value={newPassword} onChange={(event) => setNewPassword(event.target.value)} disabled={busy} /></label>
          <label>ПОВТОРІТЬ ПАРОЛЬ<input type="password" autoComplete="new-password" required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} disabled={busy} /></label>
          {passwordMessage && <p role="status" className={passwordMessage === "Пароль змінено." ? "teacher-admin-success" : "teacher-admin-error"}>{passwordMessage}</p>}
          <button className="primary-button" type="submit" disabled={busy}>{busy ? "Зберігаємо…" : "Оновити пароль"}</button>
        </form>
        <button type="button" className="teacher-admin-back" onClick={() => setView("menu")}>Назад</button>
      </> : <>
        <section className="teacher-admin-dialog" role="dialog" aria-modal="true" aria-labelledby="teacher-admin-title">
          <header className="teacher-admin-heading"><div><small>АДМІНІСТРУВАННЯ</small><h2 id="teacher-admin-title">Вчителі</h2></div><button type="button" className="teacher-admin-close" aria-label="Закрити" onClick={() => { setView("menu"); setError(""); }}>×</button></header>
          {error && <p role="alert" className="teacher-admin-error">{error}<button type="button" onClick={() => void loadTeachers()} disabled={busy}>Повторити</button></p>}
          {notice && <p role="status" className="teacher-admin-success">{notice}</p>}
          <form className="teacher-admin-form teacher-add-form" onSubmit={(event) => void addTeacher(event)}>
            <h3>Додати вчителя</h3>
            <label>ЕЛЕКТРОННА ПОШТА<input type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy} /></label>
            <label>ПІБ<input required maxLength={120} value={fullName} onChange={(event) => setFullName(event.target.value)} disabled={busy} /></label>
            <button className="primary-button" type="submit" disabled={busy}>{busy ? "Додаємо…" : "Додати вчителя"}</button>
          </form>
          <h3>Облікові записи</h3>
          {teachers.length ? <ul className="teacher-admin-list">{teachers.map((teacher) => {
            const protectedAccount = teacher.isAdmin || teacher.userId === identity.userId;
            return <li key={teacher.userId}>
              <div className="teacher-admin-row-main"><strong>{teacher.fullName || "Ім’я не задано"}</strong><span>{teacher.email}</span><small>{teacher.active ? "Активний" : "Вимкнений"} · {teacher.hasProfile ? "Уже входив" : "Ще не входив"}{teacher.isAdmin ? " · Адміністратор" : ""}</small></div>
              <div className="teacher-admin-actions">
                <button type="button" onClick={() => void resetPassword(teacher)} disabled={busy || protectedAccount}>Новий пароль</button>
                <button type="button" onClick={() => void toggleTeacher(teacher)} disabled={busy || protectedAccount}>{teacher.active ? "Вимкнути" : "Увімкнути"}</button>
              </div>
            </li>;
          })}</ul> : !error && <p className="teacher-admin-hint">Список учителів порожній.</p>}
        </section>
      </>}
      {temporaryPassword !== null && <div className="teacher-secret-backdrop">
        <section className="teacher-secret-dialog" role="dialog" aria-modal="true" aria-labelledby="teacher-secret-title">
          <h2 id="teacher-secret-title">{temporaryPasswordTitle}</h2>
          <p>Пароль більше не буде показано. Скопіюйте його й передайте вчителю безпечним способом.</p>
          <output className="teacher-secret-value">{temporaryPassword}</output>
          {copyMessage && <p role="status">{copyMessage}</p>}
          <div><button type="button" onClick={() => void copyTemporaryPassword()}>Копіювати</button><button type="button" className="primary-button" onClick={closeTemporaryPassword}>Закрити</button></div>
        </section>
      </div>}
    </div>}
  </div>;
}

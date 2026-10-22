import { createContext, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { User } from "@supabase/supabase-js";
import { apiErrorMessage, invokeFunction } from "../lib/function-api";
import { supabase } from "../lib/supabase";
import { attemptStorage, clearAllAttemptDrafts, STUDENT_AUTH_ERROR, STUDENT_LOGIN_PATTERN, studentEmail } from "../students/student-flow.js";

interface TeacherIdentity {
  userId: string;
  displayName: string;
  email: string;
  signOut: () => Promise<void>;
}
interface StudentIdentity {
  userId: string;
  displayName: string;
  signOut: () => Promise<void>;
}

const TeacherIdentityContext = createContext<TeacherIdentity | null>(null);
const StudentIdentityContext = createContext<StudentIdentity | null>(null);
export const useTeacherIdentity = () => useContext(TeacherIdentityContext);
export const useStudentIdentity = () => useContext(StudentIdentityContext);

type AccessPhase = "checking" | "signed_out" | "provision" | "ready" | "student_ready" | "blocked";
type LoginMode = "teacher" | "student";

export function TeacherAccessGate({ children, studentChildren }: { children: ReactNode; studentChildren?: ReactNode }) {
  const [phase, setPhase] = useState<AccessPhase>(supabase ? "checking" : "ready");
  const [user, setUser] = useState<User | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [studentLogin, setStudentLogin] = useState("");
  const [schoolName, setSchoolName] = useState("");
  const [className, setClassName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [loginMode, setLoginMode] = useState<LoginMode>("teacher");
  const loginModeRef = useRef<LoginMode>("teacher");

  async function resolveUser(nextUser: User) {
    if (!supabase) return;
    setUser(nextUser);
    setPhase("checking");
    setMessage("");
    let data: { id: string; role: string; full_name: string } | null;
    let error: unknown;
    try {
      const profile = await supabase.from("profiles").select("id, role, full_name").eq("id", nextUser.id).maybeSingle();
      data = profile.data;
      error = profile.error;
    } catch {
      data = null;
      error = new Error("Profile lookup failed");
    }
    if (error) {
      setMessage(loginModeRef.current === "student" ? STUDENT_AUTH_ERROR : "Не вдалося перевірити профіль. Перевірте з’єднання й спробуйте ще раз.");
      if (loginModeRef.current === "student") {
        setPhase("signed_out");
        await supabase.auth.signOut();
      } else setPhase("blocked");
      return;
    }
    if (data?.role === "student") {
      setDisplayName(data.full_name);
      setPhase("student_ready");
      return;
    }
    if (data?.role === "teacher") {
      setDisplayName(data.full_name);
      setPhase("ready");
      return;
    }
    if (data) {
      setMessage("Не вдалося визначити роль облікового запису.");
      setPhase("blocked");
      return;
    }
    if (loginModeRef.current === "student") {
      setMessage(STUDENT_AUTH_ERROR);
      setPhase("blocked");
      await supabase.auth.signOut();
      setPhase("signed_out");
      return;
    }
    const metadataName = nextUser.user_metadata.full_name ?? nextUser.user_metadata.name;
    setDisplayName(typeof metadataName === "string" ? metadataName : "");
    setPhase("provision");
  }

  useEffect(() => {
    if (!supabase) return;
    let mounted = true;
    const client = supabase;
    const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
      if (!mounted || event === "INITIAL_SESSION") return;
      if (session?.user) void resolveUser(session.user);
      else {
        setUser(null);
        setDisplayName("");
        clearAllAttemptDrafts(attemptStorage());
        setPassword("");
        setStudentLogin("");
        setPhase("signed_out");
      }
    });
    void client.auth.getSession().then(({ data, error }) => {
      if (!mounted) return;
      if (error) {
        setMessage("Не вдалося відновити сеанс. Увійдіть ще раз.");
        setPhase("signed_out");
      } else if (data.session?.user) void resolveUser(data.session.user);
      else setPhase("signed_out");
    }).catch(() => { if (mounted) setPhase("signed_out"); });
    return () => { mounted = false; subscription.unsubscribe(); };
  }, []);

  const signOut = async () => {
    clearAllAttemptDrafts(attemptStorage());
    setPassword("");
    setStudentLogin("");
    if (supabase) await supabase.auth.signOut();
  };
  const teacherIdentity = useMemo<TeacherIdentity | null>(() => phase === "ready" && user ? {
    userId: user.id, displayName: displayName || user.email || "Учитель", email: user.email ?? "", signOut,
  } : null, [displayName, phase, user]);
  const studentIdentity = useMemo<StudentIdentity | null>(() => phase === "student_ready" && user ? {
    userId: user.id, displayName: displayName || "Учень", signOut,
  } : null, [displayName, phase, user]);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    setBusy(true);
    setMessage("");
    if (loginModeRef.current === "student") {
      const normalizedLogin = studentLogin.trim().toLowerCase();
      const studentAddress = studentEmail(normalizedLogin, import.meta.env.VITE_STUDENT_EMAIL_DOMAIN);
      if (!STUDENT_LOGIN_PATTERN.test(normalizedLogin) || !studentAddress) {
        setBusy(false);
        setMessage(STUDENT_AUTH_ERROR);
        return;
      }
      try {
        const { data, error } = await supabase.auth.signInWithPassword({ email: studentAddress, password });
        setBusy(false);
        if (error || !data.user) {
          setMessage(STUDENT_AUTH_ERROR);
          return;
        }
        setPassword("");
        await resolveUser(data.user);
      } catch {
        setBusy(false);
        setMessage(STUDENT_AUTH_ERROR);
      }
      return;
    }
    const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error || !data.user) {
      setMessage(authErrorMessage(error?.code));
      return;
    }
    setPassword("");
    await resolveUser(data.user);
  }

  async function provisionTeacher(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !user) return;
    setBusy(true);
    setMessage("");
    const result = await invokeFunction(supabase, "provision-teacher", {
      fullName: displayName.trim(),
      ...(schoolName.trim() ? { schoolName: schoolName.trim() } : {}),
      ...(className.trim() ? { className: className.trim() } : {}),
    });
    setBusy(false);
    if (!result.ok) {
      setMessage(apiErrorMessage(result.error.code));
      if (result.error.code === "unauthenticated") setPhase("signed_out");
      return;
    }
    setPhase("ready");
  }

  if (phase === "ready") return <TeacherIdentityContext.Provider value={teacherIdentity}>{children}</TeacherIdentityContext.Provider>;
  if (phase === "student_ready") return <StudentIdentityContext.Provider value={studentIdentity}>{studentChildren ?? <StudentPortalUnavailable onSignOut={signOut} />}</StudentIdentityContext.Provider>;

  return (
    <main className="access-shell student-login-shell">
      <a className="brand access-brand" href="#home" aria-label="Навчальна студія"><span className="brand-mark">н</span><span>навчальна<span className="brand-light">студія</span></span></a>
      <section className="access-card" aria-live="polite">
        {phase === "checking" ? <p className="access-status">Перевіряємо ваш обліковий запис…</p> : phase === "signed_out" ? <>
          <div className="login-mode-switch" role="group" aria-label="Тип облікового запису">
            <button type="button" className={loginMode === "teacher" ? "selected" : ""} onClick={() => { loginModeRef.current = "teacher"; setLoginMode("teacher"); setPassword(""); setMessage(""); }}>Учитель</button>
            <button type="button" className={loginMode === "student" ? "selected" : ""} onClick={() => { loginModeRef.current = "student"; setLoginMode("student"); setPassword(""); setMessage(""); }}>Учень</button>
          </div>
          <div className="eyebrow muted">{loginMode === "student" ? "КАБІНЕТ УЧНЯ" : "КАБІНЕТ УЧИТЕЛЯ"}</div>
          <h1>{loginMode === "student" ? "Привіт! Час навчатися" : "Раді вас бачити"}</h1>
          <p className="access-copy">{loginMode === "student" ? "Введіть логін і пароль, які вам видав учитель." : "Увійдіть, щоб продовжити роботу з навчальними матеріалами."}</p>
          <form className="access-form" onSubmit={signIn}>
            {loginMode === "student" ? <label className="field-label">ЛОГІН<input type="text" required minLength={4} maxLength={4} pattern="[a-hjkmnp-zA-HJKMNP-Z]{4}" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="username" value={studentLogin} onChange={(event) => setStudentLogin(event.target.value)} /></label> : <label className="field-label">ЕЛЕКТРОННА ПОШТА<input type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>}
            <label className="field-label">ПАРОЛЬ<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            {message && <p className="access-message" role="alert">{message}</p>}
            <button className="primary-button form-submit" type="submit" disabled={busy}>{busy ? "Входимо…" : "Увійти"}</button>
          </form>
          {loginMode === "teacher" && <p className="access-footnote">Реєстрація доступна лише через власника платформи.</p>}
        </> : phase === "provision" ? <>
          <div className="eyebrow muted">НАЛАШТУВАННЯ ПРОФІЛЮ</div><h1>Створімо ваш простір</h1><p className="access-copy">Профіль учителя ще не налаштовано. Заповніть ім’я, щоб створити ваш клас.</p>
          <form className="access-form" onSubmit={provisionTeacher}>
            <label className="field-label">ІМ’Я ТА ПРІЗВИЩЕ<input required maxLength={160} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
            <label className="field-label">ШКОЛА — НЕОБОВ’ЯЗКОВО<input maxLength={160} value={schoolName} onChange={(event) => setSchoolName(event.target.value)} /></label>
            <label className="field-label">НАЗВА КЛАСУ — НЕОБОВ’ЯЗКОВО<input maxLength={80} value={className} onChange={(event) => setClassName(event.target.value)} /></label>
            {message && <p className="access-message" role="alert">{message}</p>}
            <button className="primary-button form-submit" type="submit" disabled={busy || !displayName.trim()}>{busy ? "Налаштовуємо…" : "Створити профіль учителя"}</button>
          </form><button className="text-button" type="button" onClick={() => void signOut()}>Вийти з облікового запису</button>
        </> : <><div className="eyebrow muted">ДОСТУП ОБМЕЖЕНО</div><h1>Не вдалося відкрити кабінет</h1><p className="access-message" role="alert">{message || "Спробуйте ще раз пізніше."}</p><button className="primary-button form-submit" type="button" onClick={() => void signOut()}>Вийти</button></>}
      </section><p className="access-caption">Маленькі кроки — великі відкриття.</p>
    </main>
  );
}

function StudentPortalUnavailable({ onSignOut }: { onSignOut: () => Promise<void> }) {
  return <main className="student-shell"><p>Екран учня тимчасово недоступний.</p><button className="student-button" onClick={() => void onSignOut()}>Вийти</button></main>;
}

function authErrorMessage(code?: string): string {
  if (code === "email_not_confirmed") return "Підтвердіть електронну пошту або зверніться до адміністратора.";
  if (code === "too_many_requests") return "Забагато спроб входу. Зачекайте трохи й повторіть.";
  return "Не вдалося увійти. Перевірте пошту й пароль.";
}

import { createContext, useContext, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { User } from "@supabase/supabase-js";
import { apiErrorMessage, invokeFunction } from "../lib/function-api";
import { supabase } from "../lib/supabase";

interface TeacherIdentity {
  displayName: string;
  email: string;
  signOut: () => Promise<void>;
}

const TeacherIdentityContext = createContext<TeacherIdentity | null>(null);

export function useTeacherIdentity(): TeacherIdentity | null {
  return useContext(TeacherIdentityContext);
}

type AccessPhase = "checking" | "signed_out" | "provision" | "ready" | "blocked";

export function TeacherAccessGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<AccessPhase>(supabase ? "checking" : "ready");
  const [user, setUser] = useState<User | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [schoolName, setSchoolName] = useState("");
  const [className, setClassName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function resolveUser(nextUser: User) {
    if (!supabase) return;
    setUser(nextUser);
    setPhase("checking");
    setMessage("");

    const { data, error } = await supabase
      .from("profiles")
      .select("id, role, full_name")
      .eq("id", nextUser.id)
      .maybeSingle();

    if (error) {
      setMessage("Не вдалося перевірити профіль. Перевірте з’єднання й спробуйте ще раз.");
      setPhase("blocked");
      return;
    }

    if (data) {
      if (data.role !== "teacher") {
        setMessage("Цей обліковий запис не має доступу до вчительського кабінету.");
        setPhase("blocked");
        return;
      }
      setDisplayName(data.full_name);
      setPhase("ready");
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
      if (session?.user) {
        void resolveUser(session.user);
      } else {
        setUser(null);
        setDisplayName("");
        setPhase("signed_out");
      }
    });

    void client.auth.getSession().then(({ data, error }) => {
      if (!mounted) return;
      if (error) {
        setMessage("Не вдалося відновити сеанс. Увійдіть ще раз.");
        setPhase("signed_out");
      } else if (data.session?.user) {
        void resolveUser(data.session.user);
      } else {
        setPhase("signed_out");
      }
    }).catch(() => {
      if (mounted) setPhase("signed_out");
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const identity = useMemo<TeacherIdentity | null>(() => {
    if (phase !== "ready" || !user) return null;
    return {
      displayName: displayName || user.email || "Учитель",
      email: user.email ?? "",
      signOut: async () => {
        if (!supabase) return;
        await supabase.auth.signOut();
      },
    };
  }, [displayName, phase, user]);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    setBusy(true);
    setMessage("");
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setBusy(false);
    if (error || !data.user) {
      setMessage(authErrorMessage(error?.code));
      return;
    }
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

  if (phase === "ready") {
    return <TeacherIdentityContext.Provider value={identity}>{children}</TeacherIdentityContext.Provider>;
  }

  return (
    <main className="access-shell">
      <a className="brand access-brand" href="#home" aria-label="Навчальна студія">
        <span className="brand-mark">н</span><span>навчальна<span className="brand-light">студія</span></span>
      </a>
      <section className="access-card" aria-live="polite">
        {phase === "checking" ? (
          <p className="access-status">Перевіряємо ваш обліковий запис…</p>
        ) : phase === "signed_out" ? (
          <>
            <div className="eyebrow muted">КАБІНЕТ УЧИТЕЛЯ</div>
            <h1>Раді вас бачити</h1>
            <p className="access-copy">Увійдіть, щоб продовжити роботу з навчальними матеріалами.</p>
            <form className="access-form" onSubmit={signIn}>
              <label className="field-label">ЕЛЕКТРОННА ПОШТА<input type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
              <label className="field-label">ПАРОЛЬ<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
              {message && <p className="access-message" role="alert">{message}</p>}
              <button className="primary-button form-submit" type="submit" disabled={busy}>{busy ? "Входимо…" : "Увійти"}</button>
            </form>
            <p className="access-footnote">Реєстрація доступна лише через власника платформи.</p>
          </>
        ) : phase === "provision" ? (
          <>
            <div className="eyebrow muted">НАЛАШТУВАННЯ ПРОФІЛЮ</div>
            <h1>Створімо ваш простір</h1>
            <p className="access-copy">Профіль учителя ще не налаштовано. Заповніть ім’я, щоб створити ваш клас.</p>
            <form className="access-form" onSubmit={provisionTeacher}>
              <label className="field-label">ІМ’Я ТА ПРІЗВИЩЕ<input required maxLength={160} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
              <label className="field-label">ШКОЛА — НЕОБОВ’ЯЗКОВО<input maxLength={160} value={schoolName} onChange={(event) => setSchoolName(event.target.value)} /></label>
              <label className="field-label">НАЗВА КЛАСУ — НЕОБОВ’ЯЗКОВО<input maxLength={80} value={className} onChange={(event) => setClassName(event.target.value)} /></label>
              {message && <p className="access-message" role="alert">{message}</p>}
              <button className="primary-button form-submit" type="submit" disabled={busy || !displayName.trim()}>{busy ? "Налаштовуємо…" : "Створити профіль учителя"}</button>
            </form>
            <button className="text-button" type="button" onClick={() => void supabase?.auth.signOut()}>Вийти з облікового запису</button>
          </>
        ) : (
          <>
            <div className="eyebrow muted">ДОСТУП ОБМЕЖЕНО</div>
            <h1>Не вдалося відкрити кабінет</h1>
            <p className="access-message" role="alert">{message || "Спробуйте ще раз пізніше."}</p>
            <button className="primary-button form-submit" type="button" onClick={() => void supabase?.auth.signOut()}>Вийти</button>
          </>
        )}
      </section>
      <p className="access-caption">Маленькі кроки — великі відкриття.</p>
    </main>
  );
}

function authErrorMessage(code?: string): string {
  if (code === "email_not_confirmed") return "Підтвердіть електронну пошту або зверніться до адміністратора.";
  if (code === "too_many_requests") return "Забагато спроб входу. Зачекайте трохи й повторіть.";
  return "Не вдалося увійти. Перевірте пошту й пароль.";
}


import { useCallback, useEffect, useState } from "react";
import type { CreatedStudent } from "../../contracts/api";
import { apiErrorMessage, invokeFunction } from "../lib/function-api";
import { supabase } from "../lib/supabase";

interface ClassRow {
  id: string;
  name: string;
}
interface StudentRow {
  student_id: string;
  profiles: { full_name: string; student_login_code: string } | null;
}

export function StudentManagement() {
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [classId, setClassId] = useState("");
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [names, setNames] = useState("");
  const [credentials, setCredentials] = useState<CreatedStudent[] | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const client = supabase;

  const loadClasses = useCallback(async () => {
    if (!client) return;
    const { data, error } = await client.from("class_teachers")
      .select("class_id, classes(id, name)").order("class_id");
    if (error) {
      setMessage("Не вдалося завантажити класи. Спробуйте оновити сторінку.");
      return;
    }
    const rows = (data ?? []).flatMap((row: { classes: ClassRow | ClassRow[] | null }) => {
      const value = Array.isArray(row.classes) ? row.classes[0] : row.classes;
      return value ? [value] : [];
    });
    setClasses(rows);
    setClassId((current) => current && rows.some((item) => item.id === current) ? current : rows[0]?.id ?? "");
  }, [client]);

  const loadStudents = useCallback(async () => {
    if (!client || !classId) { setStudents([]); return; }
    const { data, error } = await client.from("class_students")
      .select("student_id, profiles!inner(full_name, student_login_code)")
      .eq("class_id", classId).order("student_id");
    if (error) {
      setMessage("Не вдалося завантажити учнів. Перевірте з’єднання й повторіть спробу.");
      return;
    }
    setStudents((data ?? []) as unknown as StudentRow[]);
  }, [client, classId]);

  useEffect(() => { void loadClasses(); }, [loadClasses]);
  useEffect(() => { void loadStudents(); }, [loadStudents]);

  async function createStudents(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client || !classId) return;
    const fullNames = names.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
    if (!fullNames.length) return;
    if (fullNames.length > 40) { setMessage("За один раз можна додати не більше 40 учнів."); return; }
    if (fullNames.some((name) => name.length > 160)) { setMessage("Ім’я кожного учня має містити не більше 160 символів."); return; }
    setBusy(true); setMessage(""); setCredentials(null);
    const result = await invokeFunction(client, "create-students", {
      classId, students: fullNames.map((fullName) => ({ fullName })),
    });
    setBusy(false);
    if (!result.ok) { setMessage(apiErrorMessage(result.error.code)); return; }
    setNames(""); setCredentials(result.data.students);
    await loadStudents();
  }

  async function resetPassword(studentId: string) {
    if (!client) return;
    setBusy(true); setMessage(""); setCredentials(null);
    const result = await invokeFunction(client, "reset-student-password", { studentId });
    setBusy(false);
    if (!result.ok) { setMessage(apiErrorMessage(result.error.code)); return; }
    setCredentials([{ studentId: result.data.studentId, fullName: students.find((s) => s.student_id === studentId)?.profiles?.full_name ?? "Учень", login: result.data.login, password: result.data.password }]);
  }

  async function deleteStudent(studentId: string) {
    if (!client) return;
    const studentName = students.find((item) => item.student_id === studentId)?.profiles?.full_name ?? "цього учня";
    if (!window.confirm(`Видалити ${studentName}? Цю дію не можна скасувати.`)) return;
    setBusy(true); setMessage("");
    const result = await invokeFunction(client, "delete-student", { studentId });
    setBusy(false);
    if (!result.ok) { setMessage(apiErrorMessage(result.error.code)); return; }
    setStudents((current) => current.filter((item) => item.student_id !== studentId));
    setMessage("Учня видалено.");
  }

  if (!client) return null;

  return (
    <section className="class-management" id="classes">
      <div className="class-heading">
        <div><div className="eyebrow muted">КАБІНЕТ УЧИТЕЛЯ</div><h2>Мої класи й учні</h2></div>
        {classes.length > 0 && <label className="field-label">КЛАС<select value={classId} onChange={(event) => { setClassId(event.target.value); setCredentials(null); }}>
          {classes.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
        </select></label>}
      </div>
      {!classes.length ? <p className="class-empty">Після налаштування профілю тут з’явиться ваш клас.</p> : <>
        <form className="student-create" onSubmit={createStudents}>
          <label className="field-label">ДОДАТИ УЧНІВ <textarea value={names} onChange={(event) => setNames(event.target.value)} placeholder={"Ім’я та прізвище кожного учня — з нового рядка"} rows={3} /></label>
          <button className="primary-button" disabled={busy || !names.trim()}>{busy ? "Обробляємо…" : "Створити доступи"}</button>
          <small>До 40 учнів за раз. Паролі буде показано лише один раз.</small>
        </form>
        {message && <p className="class-message" role="status">{message}</p>}
        {credentials && <div className="credentials-panel" role="dialog" aria-modal="true" aria-labelledby="credentials-title">
          <h3 id="credentials-title">Дані для входу</h3>
          <p>Передайте ці дані учням зараз. Паролі більше не можна буде переглянути.</p>
          <div className="credentials-table"><div><b>Учень</b><b>Логін</b><b>Пароль</b></div>{credentials.map((item) => <div key={item.studentId}><span>{item.fullName}</span><code>{item.login}</code><code>{item.password}</code></div>)}</div>
          <button className="primary-button" onClick={() => setCredentials(null)}>Я зберіг(ла) дані, закрити</button>
        </div>}
        <div className="student-list">
          {students.map((item) => <article className="student-row" key={item.student_id}>
            <span className="student-avatar">{item.profiles?.full_name.slice(0, 1) ?? "У"}</span>
            <strong>{item.profiles?.full_name ?? "Учень"}</strong><code>{item.profiles?.student_login_code}</code>
            <button type="button" disabled={busy} onClick={() => void resetPassword(item.student_id)}>Новий пароль</button>
            <button type="button" className="student-delete" disabled={busy} onClick={() => void deleteStudent(item.student_id)}>Видалити</button>
          </article>)}
          {!students.length && <p className="class-empty">У цьому класі поки немає учнів.</p>}
        </div>
      </>}
    </section>
  );
}


> multiplication-practice@0.1.0 build
> tsc -b && vite build

vite v7.3.7 building client environment for production...
transforming...
✓ 103 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                   0.66 kB │ gzip:  0.43 kB
dist/assets/index-BNROS3I5.css   14.01 kB │ gzip:  3.83 kB
dist/assets/index-BjOnix0K.js   198.17 kB │ gzip: 62.86 kB
✓ built in 1.49s

> multiplication-practice@0.1.0 test
> node --test src/domain.test.js

✔ migrates legacy subject ids while retaining draft data (2.1291ms)
✔ returns null for an invalid stored draft collection (0.1912ms)
✔ migrates the legacy choice type only for v1 drafts (0.2018ms)
✔ drops malformed items without throwing and detects incomplete legacy collections (0.266ms)
✔ keeps every database question type distinguishable in the UI (0.2856ms)
✔ parses API envelopes and maps access errors to Ukrainian UI copy (0.4039ms)
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 180.308
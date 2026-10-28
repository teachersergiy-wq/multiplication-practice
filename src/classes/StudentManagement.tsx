import { useCallback, useEffect, useState } from "react";
import type { CreateClassData, CreatedStudent, SetClassSubjectData } from "../../contracts/api";
import { apiErrorMessage, invokeFunction } from "../lib/function-api";
import { supabase } from "../lib/supabase";
import { CLASS_LIST_CHANGED_EVENT, announceClassListChanged, classSelectionAfterRefresh } from "./class-api.js";
import { ClassSetupDialog } from "./ClassSetupDialog";
import { TeacherCompetitiveResults } from "../competitive/TeacherCompetitiveResults";

interface ClassRow {
  id: string;
  name: string;
  subjects: { subjectId: string; gradeLevel: number }[];
}
interface StudentRow {
  student_id: string;
  profiles: { full_name: string } | null;
}

export function StudentManagement() {
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [classId, setClassId] = useState("");
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [names, setNames] = useState("");
  const [credentials, setCredentials] = useState<CreatedStudent[] | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [configureClassId, setConfigureClassId] = useState("");
  const [teacherId, setTeacherId] = useState("");
  const client = supabase;

  useEffect(() => {
    if (!client) return;
    let active = true;
    void client.auth.getUser().then(({ data }) => { if (active) setTeacherId(data.user?.id ?? ""); });
    return () => { active = false; };
  }, [client]);

  const loadClasses = useCallback(async (preferredClassId = "") => {
    if (!client) return;
    const { data, error } = await client.from("class_teachers")
      .select("class_id, classes(id, name)").order("class_id");
    if (error) {
      setMessage("Не вдалося завантажити класи. Спробуйте оновити сторінку.");
      return;
    }
    const classRows = (data ?? []).flatMap((row: { class_id: string; classes: { id: string; name: string } | { id: string; name: string }[] | null }) => {
      const value = Array.isArray(row.classes) ? row.classes[0] : row.classes;
      return value ? [{ ...value, subjects: [] as ClassRow["subjects"] }] : [];
    });
    const subjectResult = classRows.length
      ? await client.from("class_subjects").select("class_id,subject_id,grade_level").in("class_id", classRows.map((item) => item.id))
      : { data: [], error: null };
    if (subjectResult.error) {
      setMessage("Не вдалося завантажити налаштування класів. Спробуйте оновити сторінку.");
      return;
    }
    for (const mapping of subjectResult.data ?? []) {
      const row = classRows.find((item) => item.id === mapping.class_id);
      row?.subjects.push({ subjectId: mapping.subject_id, gradeLevel: mapping.grade_level });
    }
    const rows = classRows;
    setClasses(rows);
    setClassId((current) => classSelectionAfterRefresh(rows, current, preferredClassId));
  }, [client]);

  const loadStudents = useCallback(async () => {
    if (!client || !classId) { setStudents([]); return; }
    const { data, error } = await client.from("class_students")
      .select("student_id, profiles!inner(full_name)")
      .eq("class_id", classId).order("student_id");
    if (error) {
      setMessage("Не вдалося завантажити учнів. Перевірте з’єднання й повторіть спробу.");
      return;
    }
    setStudents((data ?? []) as unknown as StudentRow[]);
  }, [client, classId]);

  useEffect(() => { void loadClasses(); }, [loadClasses]);
  useEffect(() => {
    const refresh = () => { void loadClasses(); };
    window.addEventListener(CLASS_LIST_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(CLASS_LIST_CHANGED_EVENT, refresh);
  }, [loadClasses]);
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

  const selectedClass = classes.find((item) => item.id === classId);

  return (
    <section className="class-management" id="classes">
      <div className="class-heading">
        <div><div className="eyebrow muted">КАБІНЕТ УЧИТЕЛЯ</div><h2>Мої класи й учні</h2></div>
        <button type="button" className="primary-button" disabled={!teacherId} onClick={() => { setConfigureClassId(""); setSetupOpen(true); }}>Додати клас</button>
        {classes.length > 0 && <label className="field-label">КЛАС<select value={classId} onChange={(event) => { setClassId(event.target.value); setStudents([]); setCredentials(null); }}>
          {classes.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
        </select></label>}
      </div>
      {!classes.length ? <p className="class-empty">Створіть клас і вкажіть предмет та рівень, щоб додавати учнів і призначати тести.</p> : <>
        {selectedClass && !selectedClass.subjects.length && <div className="class-setup-notice"><p>Для класу «{selectedClass.name}» ще не задано предмет і рівень.</p><button type="button" onClick={() => { setConfigureClassId(selectedClass.id); setSetupOpen(true); }}>Налаштувати клас</button></div>}
        {selectedClass?.subjects.length ? <p className="class-subject-summary">Предмет і рівень класу налаштовано.</p> : null}
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
            <strong>{item.profiles?.full_name ?? "Учень"}</strong>
            <button type="button" disabled={busy} aria-label={`Створити новий пароль для ${item.profiles?.full_name ?? "учня"}`} onClick={() => void resetPassword(item.student_id)}>Новий пароль</button>
            <button type="button" className="student-delete" disabled={busy} aria-label={`Видалити учня ${item.profiles?.full_name ?? "без імені"}`} onClick={() => void deleteStudent(item.student_id)}>Видалити</button>
          </article>)}
          {!students.length && <p className="class-empty">У цьому класі поки немає учнів.</p>}
        </div>
        {selectedClass && <TeacherCompetitiveResults client={client} classId={selectedClass.id} className={selectedClass.name} />}
      </>}
      {setupOpen && <ClassSetupDialog client={client} teacherId={teacherId} initialClassId={configureClassId} onClose={() => setSetupOpen(false)} onSaved={(result: CreateClassData | SetClassSubjectData) => {
        setSetupOpen(false);
        if ("name" in result) {
          setClassId(result.classId);
          setMessage(`Клас «${result.name}» створено.`);
          announceClassListChanged();
          void loadClasses(result.classId);
        } else {
          setMessage("Предмет і рівень класу налаштовано.");
          announceClassListChanged();
          void loadClasses(result.classId);
        }
      }} />}
    </section>
  );
}

import { useEffect, useMemo, useState } from "react";
import type { CreateClassData, SetClassSubjectData } from "../../contracts/api";
import { apiErrorMessage, invokeFunction } from "../lib/function-api";
import type { supabase } from "../lib/supabase";
import { classFunctionMessage, saveClass, validateClassInput } from "./class-api.js";

type Client = NonNullable<typeof supabase>;
type OwnedClass = { id: string; name: string };
type SubjectOption = { id: string; code: string; name: string };

interface Props {
  client: Client;
  teacherId: string;
  initialClassId?: string;
  initialSubjectId?: string;
  initialGradeLevel?: number;
  onClose: () => void;
  onSaved: (result: CreateClassData | SetClassSubjectData) => void;
}

export function ClassSetupDialog({ client, teacherId, initialClassId = "", initialSubjectId = "", initialGradeLevel = 1, onClose, onSaved }: Props) {
  const [mode, setMode] = useState<"create" | "configure">(initialClassId ? "configure" : "create");
  const [classes, setClasses] = useState<OwnedClass[]>([]);
  const [subjects, setSubjects] = useState<SubjectOption[]>([]);
  const [className, setClassName] = useState("");
  const [classId, setClassId] = useState(initialClassId);
  const [subjectId, setSubjectId] = useState("");
  const [gradeLevel, setGradeLevel] = useState(String(initialGradeLevel));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void (async () => {
      const [classResult, subjectResult] = await Promise.all([
        client.from("class_teachers").select("class_id, classes(id,name)").eq("teacher_id", teacherId).order("class_id"),
        client.from("subjects").select("id,code,name").eq("active", true).order("name"),
      ]);
      if (!active) return;
      if (classResult.error || subjectResult.error) {
        setError("Не вдалося завантажити класи й предмети. Перевірте з’єднання та спробуйте ще раз.");
      } else {
        const owned = (classResult.data ?? []).flatMap((row: { classes: OwnedClass | OwnedClass[] | null }) => {
          const item = Array.isArray(row.classes) ? row.classes[0] : row.classes;
          return item ? [item] : [];
        });
        const availableSubjects = (subjectResult.data ?? []) as SubjectOption[];
        setClasses(owned);
        setSubjects(availableSubjects);
        setClassId((current) => current && owned.some((item) => item.id === current) ? current : owned[0]?.id || "");
        setSubjectId((current) => current || (availableSubjects.some((item) => item.id === initialSubjectId) ? initialSubjectId : availableSubjects[0]?.id || ""));
      }
      setLoading(false);
    })();
    return () => { active = false; };
  }, [client, teacherId, initialSubjectId]);

  const selectedClassName = useMemo(() => classes.find((item) => item.id === classId)?.name ?? "", [classes, classId]);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const values = validateClassInput(mode === "create" ? className : selectedClassName, gradeLevel, subjectId);
    if (!values.ok) {
      setError(values.reason === "name" ? "Назва класу має містити від 1 до 80 символів." : values.reason === "grade" ? "Оберіть рівень від 1 до 12." : "Оберіть предмет.");
      return;
    }
    if (mode === "configure" && !classId) { setError("Оберіть клас для налаштування."); return; }
    setBusy(true);
    const result = mode === "create"
      ? await saveClass("create", { name: values.name, gradeLevel: values.gradeLevel, subjectId: values.subjectId }, (name, body) => invokeFunction(client, name, body))
      : await saveClass("configure", { classId, gradeLevel: values.gradeLevel, subjectId: values.subjectId }, (name, body) => invokeFunction(client, name, body));
    setBusy(false);
    if (!result.ok) {
      setError(result.error.code === "conflict" || result.error.code === "invalid_request" || result.error.code === "forbidden" || result.error.code === "not_found" || result.error.code === "unauthenticated"
        ? classFunctionMessage(result.error.code, mode)
        : apiErrorMessage(result.error.code));
      return;
    }
    onSaved(result.data);
  }

  return <div className="class-setup-backdrop">
    <section className="class-setup-dialog" role="dialog" aria-modal="true" aria-labelledby="class-setup-title">
      <div className="class-setup-heading"><div><div className="eyebrow muted">КЛАСИ</div><h3 id="class-setup-title">{mode === "create" ? "Додати клас" : "Налаштувати клас"}</h3></div><button type="button" className="class-setup-close" aria-label="Закрити" onClick={onClose}>×</button></div>
      <div className="class-setup-mode" role="group" aria-label="Дія з класом">
        <button type="button" className={mode === "create" ? "selected" : ""} onClick={() => { setMode("create"); setError(""); }}>Новий клас</button>
        <button type="button" className={mode === "configure" ? "selected" : ""} disabled={!classes.length} onClick={() => { setMode("configure"); setError(""); }}>Наявний клас</button>
      </div>
      {loading ? <p role="status">Завантажуємо класи й предмети…</p> : <form className="class-setup-form" onSubmit={(event) => void save(event)}>
        {mode === "create" ? <label className="field-label">НАЗВА КЛАСУ<input value={className} maxLength={80} autoComplete="off" onChange={(event) => setClassName(event.target.value)} placeholder="Наприклад, 8-А" disabled={busy} /></label> : <label className="field-label">КЛАС<select value={classId} onChange={(event) => setClassId(event.target.value)} disabled={busy}><option value="">Оберіть клас</option>{classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
        <label className="field-label">ПРЕДМЕТ<select value={subjectId} onChange={(event) => setSubjectId(event.target.value)} disabled={busy || !subjects.length}><option value="">Оберіть предмет</option>{subjects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="field-label">РІВЕНЬ / КЛАС<select value={gradeLevel} onChange={(event) => setGradeLevel(event.target.value)} disabled={busy}>{Array.from({ length: 11 }, (_, index) => index + 1).map((grade) => <option key={grade} value={grade}>{grade} клас</option>)}</select></label>
        {mode === "configure" && selectedClassName && <p className="class-setup-help">Для класу «{selectedClassName}» буде додано вибраний предмет і рівень. Якщо рівень уже пов’язаний із призначенням, сервер не дозволить його змінити.</p>}
        {!subjects.length && <p className="class-setup-error" role="alert">Немає доступних предметів для налаштування.</p>}
        {error && <p className="class-setup-error" role="alert">{error}</p>}
        <div className="class-setup-actions"><button type="button" onClick={onClose} disabled={busy}>Скасувати</button><button className="primary-button" type="submit" disabled={busy || !subjects.length}>{busy ? "Зберігаємо…" : mode === "create" ? "Створити клас" : "Зберегти налаштування"}</button></div>
      </form>}
    </section>
  </div>;
}

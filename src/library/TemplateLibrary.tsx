import { useCallback, useEffect, useMemo, useState } from "react";
import type { Subject } from "../domain";
import { assessmentDraftStorageKey, migrateAssessmentDrafts } from "../domain";
import type { supabase } from "../lib/supabase";

type Client = NonNullable<typeof supabase>;
type SubjectRow = { id: string; code: string; name: string; icon: string };
type TemplateRow = {
  id: string;
  title: string;
  subject_id: string;
  grade_level: number;
  status: string;
  created_at: string;
  updated_at: string;
};

interface Props {
  client: Client;
  teacherId: string;
  subjects: Subject[];
  subjectCode: string;
  grade: number;
  onGradeChange: (grade: number) => void;
  onOpen: (draft: { id: string; title: string }) => void;
}

const statusNames: Record<string, string> = {
  draft: "Чернетка",
  published: "Опублікований",
  archived: "Архів",
};

export function TemplateLibrary({ client, teacherId, subjects, subjectCode, grade, onGradeChange, onOpen }: Props) {
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [subjectRows, setSubjectRows] = useState<SubjectRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [templateResult, subjectResult] = await Promise.all([
        client.from("assessment_templates")
          .select("id,title,subject_id,grade_level,status,created_at,updated_at")
          .eq("teacher_id", teacherId)
          .order("updated_at", { ascending: false }),
        client.from("subjects").select("id,code,name,icon").eq("active", true),
      ]);
      if (templateResult.error || subjectResult.error) throw templateResult.error ?? subjectResult.error;
      setTemplates((templateResult.data ?? []) as TemplateRow[]);
      setSubjectRows((subjectResult.data ?? []) as SubjectRow[]);
    } catch {
      setError("Не вдалося завантажити бібліотеку. Перевірте з’єднання й повторіть спробу.");
    } finally {
      setLoading(false);
    }
  }, [client, teacherId]);

  useEffect(() => { void reload(); }, [reload]);

  const visible = useMemo(() => {
    const subjectId = subjectRows.find((subject) => subject.code === subjectCode)?.id;
    return templates.filter((item) => item.subject_id === subjectId && item.grade_level === grade);
  }, [grade, subjectCode, subjectRows, templates]);

  async function createDraft(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const subject = subjectRows.find((item) => item.code === subjectCode);
    if (!subject) { setError("Обраний предмет недоступний. Оновіть список предметів."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const { error: createError } = await client.from("assessment_templates").insert({
        teacher_id: teacherId,
        subject_id: subject.id,
        grade_level: grade,
        title: newTitle.trim() || `${subject.name} · ${grade} клас`,
        mode: "practice",
        status: "draft",
      });
      if (createError) throw createError;
      setNewTitle("");
      setNotice("Чернетку створено.");
      await reload();
    } catch {
      setError("Не вдалося створити чернетку. Перевірте дані й повторіть спробу.");
    } finally { setBusy(false); }
  }

  async function renameDraft(id: string) {
    const value = renameValue.trim();
    if (!value || value.length > 180) { setError("Назва має містити від 1 до 180 символів."); return; }
    setBusy(true); setError("");
    try {
      const { error: updateError } = await client.from("assessment_templates").update({ title: value }).eq("id", id).eq("teacher_id", teacherId).eq("status", "draft");
      if (updateError) throw updateError;
      setRenamingId(null);
      await reload();
    } catch { setError("Не вдалося перейменувати чернетку."); }
    finally { setBusy(false); }
  }

  async function deleteDraft(item: TemplateRow) {
    if (!window.confirm(`Видалити чернетку «${item.title}»?`)) return;
    setBusy(true); setError("");
    try {
      const { error: deleteError } = await client.from("assessment_templates").delete().eq("id", item.id).eq("teacher_id", teacherId).eq("status", "draft");
      if (deleteError) throw deleteError;
      setTemplates((current) => current.filter((row) => row.id !== item.id));
    } catch { setError("Не вдалося видалити чернетку."); }
    finally { setBusy(false); }
  }

  async function importLocalDrafts() {
    let parsed: unknown;
    try { parsed = JSON.parse(localStorage.getItem(assessmentDraftStorageKey(teacherId)) ?? "null"); }
    catch { setError("Локальні чернетки пошкоджені й не можуть бути прочитані."); return; }
    const drafts = migrateAssessmentDrafts(parsed);
    if (!drafts?.length) { setNotice("Локальних чернеток для цього облікового запису не знайдено."); return; }
    const subjectIds = new Map(subjectRows.map((subject) => [subject.code, subject.id]));
    const importable = drafts.filter((draft) => subjectIds.has(draft.subjectId) && draft.grade >= 1 && draft.grade <= 12);
    if (!importable.length) { setError("Не знайдено чернеток із доступними предметами та класами."); return; }
    setBusy(true); setError(""); setNotice("");
    let imported = 0;
    try {
      for (const draft of importable) {
        const { error: importError } = await client.from("assessment_templates").insert({
          teacher_id: teacherId,
          subject_id: subjectIds.get(draft.subjectId),
          grade_level: draft.grade,
          title: draft.title.slice(0, 180),
          mode: "practice",
          status: "draft",
          settings: { importedFromLocalDraft: true },
        });
        if (importError) throw importError;
        imported++;
      }
      setNotice(`Імпортовано чернеток: ${imported}. Локальні копії залишилися у браузері.`);
      await reload();
    } catch {
      setError(`Імпортовано ${imported} з ${importable.length}. Решту можна імпортувати повторною дією; локальні копії збережено.`);
    } finally { setBusy(false); }
  }

  function subjectFor(item: TemplateRow) {
    const row = subjectRows.find((subject) => subject.id === item.subject_id);
    const ui = subjects.find((subject) => subject.code === row?.code);
    return { name: row?.name ?? "Предмет", icon: ui?.icon ?? row?.icon ?? "✳", tone: ui?.tone ?? "mint" };
  }

  return <section className="template-library" aria-labelledby="template-library-heading">
    <div className="template-library-heading"><div><div className="eyebrow muted">ВАША БІБЛІОТЕКА</div><h2 id="template-library-heading">Тести та заготовки</h2></div><label className="grade-select">КЛАС <select aria-label="Фільтр за класом" value={grade} onChange={(event) => onGradeChange(Number(event.target.value))}>{Array.from({ length: 11 }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value} клас</option>)}</select></label></div>
    <form className="template-create" onSubmit={createDraft}>
      <label className="field-label">НАЗВА НОВОЇ ЧЕРНЕТКИ<input value={newTitle} maxLength={180} onChange={(event) => setNewTitle(event.target.value)} placeholder="Наприклад, Таблиця множення" /></label>
      <button className="primary-button" type="submit" disabled={busy}>{busy ? "Зберігаємо…" : "＋ Створити чернетку"}</button>
    </form>
    <div className="template-actions"><button className="text-button" type="button" onClick={() => void importLocalDrafts()} disabled={busy}>Імпортувати локальні чернетки</button><button className="text-button" type="button" onClick={() => void reload()} disabled={loading || busy}>Оновити список</button></div>
    <p className="template-clone-note">Клонування опублікованих тестів поки недоступне — серверна функція ще не підключена.</p>
    {error && <p className="template-error" role="alert">{error}</p>}{notice && <p className="template-notice" role="status">{notice}</p>}
    {loading ? <p className="template-state" role="status">Завантажуємо бібліотеку…</p> : visible.length ? <div className="draft-list">{visible.map((item) => {
      const subject = subjectFor(item);
      return <article className="draft-row template-row" key={item.id}>
        <span className={`draft-icon ${subject.tone}`}>{subject.icon}</span>
        <div className="draft-info">{renamingId === item.id ? <label className="sr-only" htmlFor={`rename-${item.id}`}>Нова назва тесту</label> : null}
          {renamingId === item.id ? <input id={`rename-${item.id}`} autoFocus maxLength={180} value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void renameDraft(item.id); } if (event.key === "Escape") setRenamingId(null); }} /> : <strong>{item.title}</strong>}
          <small>{subject.name} <i>·</i> {item.grade_level} клас <i>·</i> {statusNames[item.status] ?? item.status} <i>·</i> {new Date(item.updated_at || item.created_at).toLocaleDateString("uk-UA")}</small>
        </div>
        {item.status === "draft" ? <div className="template-row-actions">
          {renamingId === item.id ? <><button type="button" disabled={busy} onClick={() => void renameDraft(item.id)}>Зберегти назву</button><button type="button" onClick={() => setRenamingId(null)}>Скасувати</button></> : <><button type="button" onClick={() => { setRenamingId(item.id); setRenameValue(item.title); }}>Перейменувати</button><button type="button" onClick={() => onOpen({ id: item.id, title: item.title })}>Відкрити</button><button type="button" className="danger" disabled={busy} onClick={() => void deleteDraft(item)}>Видалити</button></>}
        </div> : <button className="template-clone-button" type="button" disabled title="Клонування стане доступним після розгортання clone-assessment">Клонувати · недоступно</button>}
      </article>;
    })}</div> : <div className="empty-state"><span>✎</span><strong>Для цього предмета й класу тестів ще немає</strong><p>Створіть чернетку або імпортуйте збережені локальні чернетки.</p></div>}
  </section>;
}


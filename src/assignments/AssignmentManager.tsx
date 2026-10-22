import { useCallback, useEffect, useState } from "react";
import type { AssessmentMode } from "../../contracts/api";
import { apiErrorMessage, invokeFunction } from "../lib/function-api";
import type { supabase } from "../lib/supabase";
import { isAuthoredQuestion } from "../question-validation";
import { getDraftRequest } from "../questions/editor-api.js";
import { createAssignment, deleteAssignment, fromDateTimeLocal, isValidAssignmentWindow, publishDraft, toDateTimeLocal, updateAssignmentWindow, validateQuestionsForPublication } from "./assignment-api.js";

type Client = NonNullable<typeof supabase>;
type Template = {
  id: string;
  title: string;
  subject_id: string;
  grade_level: number;
  status: string;
  mode: AssessmentMode;
};
type ClassRow = { id: string; name: string };
type AssignmentRow = {
  id: string;
  class_id: string;
  opens_at: string | null;
  closes_at: string | null;
  allow_retries: boolean;
  created_at: string;
  classes: ClassRow | ClassRow[] | null;
};

interface Props {
  client: Client;
  teacherId: string;
  template: Template;
  onClose: () => void;
  onPublished: () => void;
  editorHasUnsavedChanges: boolean;
}

function classFromRelation(value: AssignmentRow["classes"]): ClassRow | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function mutationMessage(reason: string): string {
  if (reason === "duplicate") return "Цей тест уже призначено цьому класу.";
  if (reason === "permission") return "Не вдалося змінити призначення: перевірте доступ до класу.";
  if (reason === "referenced") return "Призначення має спроби учнів і не може бути скасоване.";
  if (reason === "not_found") return "Призначення не знайдено або воно вже змінилося. Оновіть список.";
  return "Не вдалося зберегти зміни. Перевірте з’єднання й права доступу та повторіть спробу.";
}

export function AssignmentManager({ client, teacherId, template, onClose, onPublished, editorHasUnsavedChanges }: Props) {
  const [status, setStatus] = useState(template.status);
  const [mode, setMode] = useState<AssessmentMode>(template.mode);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [assignments, setAssignments] = useState<AssignmentRow[]>([]);
  const [classId, setClassId] = useState("");
  const [opensAt, setOpensAt] = useState("");
  const [closesAt, setClosesAt] = useState("");
  const [allowRetries, setAllowRetries] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadAssignments = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [teacherClasses, matchingSubjects, assignmentResult] = await Promise.all([
        client.from("class_teachers").select("class_id, classes(id,name)").eq("teacher_id", teacherId),
        client.from("class_subjects").select("class_id").eq("subject_id", template.subject_id).eq("grade_level", template.grade_level),
        client.from("assessment_assignments").select("id,class_id,opens_at,closes_at,allow_retries,created_at,classes(id,name)").eq("template_id", template.id).order("created_at", { ascending: false }),
      ]);
      if (teacherClasses.error || matchingSubjects.error || assignmentResult.error) {
        setError("Не вдалося завантажити класи або призначення. Перевірте з’єднання й доступ та спробуйте ще раз.");
        return;
      }

      const ownedRows = (teacherClasses.data ?? []) as unknown as { class_id: string; classes: ClassRow | ClassRow[] | null }[];
      const subjectClassIds = new Set((matchingSubjects.data ?? []).map((row: { class_id: string }) => row.class_id));
      const compatibleClasses = ownedRows.flatMap((row) => {
        const related = Array.isArray(row.classes) ? row.classes[0] : row.classes;
        return related && subjectClassIds.has(row.class_id) ? [related] : [];
      });
      const savedAssignments = (assignmentResult.data ?? []) as unknown as AssignmentRow[];
      const alreadyAssigned = new Set(savedAssignments.map((item) => item.class_id));
      const unassignedClasses = compatibleClasses.filter((item) => !alreadyAssigned.has(item.id));
      setClasses(compatibleClasses);
      setClassId((current) => current && unassignedClasses.some((item) => item.id === current) ? current : unassignedClasses[0]?.id ?? "");
      setAssignments(savedAssignments);
    } catch {
      setError("Не вдалося завантажити призначення. Перевірте з’єднання й спробуйте ще раз.");
    } finally {
      setLoading(false);
    }
  }, [client, teacherId, template.grade_level, template.id, template.subject_id]);

  useEffect(() => { void loadAssignments(); }, [loadAssignments]);

  async function publish() {
    if (editorHasUnsavedChanges) {
      setError("Спочатку закрийте це вікно, збережіть або скасуйте незбережені зміни в редакторі, а потім опублікуйте тест.");
      return;
    }
    setBusy(true); setError(""); setNotice("");
    const draft = await invokeFunction(client, "get-assessment-draft", getDraftRequest(template.id));
    if (!draft.ok) {
      setBusy(false);
      setError(apiErrorMessage(draft.error.code));
      return;
    }
    const questionValidation = validateQuestionsForPublication(draft.data.questions, isAuthoredQuestion);
    if (!questionValidation.ok && questionValidation.reason === "empty") {
      setBusy(false);
      setError("Додайте до тесту щонайменше одне збережене запитання перед публікацією.");
      return;
    }
    if (!questionValidation.ok) {
      setBusy(false);
      setError("Перевірте запитання: деякі з них не заповнені або не мають правильної відповіді.");
      return;
    }
    const result = await publishDraft(client, template.id, teacherId, mode, (apiClient, name, body) => invokeFunction(apiClient, name, body));
    setBusy(false);
    if (!result.ok) {
      if ("reason" in result) { setError(mutationMessage(result.reason)); return; }
      if (result.error.code === "incomplete_assessment") {
        setError("Тест не готовий до публікації. Перевірте, що в кожному запитанні задано правильну відповідь, і повторіть спробу.");
      } else if (result.error.code === "conflict") {
        setError("Стан тесту змінився. Оновіть бібліотеку й перевірте його ще раз.");
      } else {
        setError(apiErrorMessage(result.error.code));
      }
      return;
    }
    if (result.data.status !== "published" || result.data.templateId !== template.id) {
      setError("Сервер повернув неочікувану відповідь. Оновіть бібліотеку й перевірте статус тесту.");
      return;
    }
    setStatus("published");
    setNotice(`Тест опубліковано. Запитань: ${result.data.questionCount}; балів: ${result.data.totalPoints}.`);
    onPublished();
    await loadAssignments();
  }

  async function assign(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!classId) { setError("Оберіть клас, якому відповідає предмет і рівень тесту."); return; }
    if (!isValidAssignmentWindow(opensAt, closesAt)) { setError("Час завершення має бути пізніше часу відкриття."); return; }
    setBusy(true); setError(""); setNotice("");
    const result = await createAssignment(client, {
      template_id: template.id,
      class_id: classId,
      assigned_by: teacherId,
      opens_at: fromDateTimeLocal(opensAt),
      closes_at: fromDateTimeLocal(closesAt),
      allow_retries: allowRetries,
    });
    setBusy(false);
    if (!result.ok) { setError(mutationMessage(result.reason)); return; }
    setNotice("Тест призначено класу.");
    setOpensAt(""); setClosesAt(""); setAllowRetries(true);
    await loadAssignments();
  }

  async function saveWindow(assignmentId: string, values: { opensAt: string; closesAt: string; allowRetries: boolean }) {
    if (!isValidAssignmentWindow(values.opensAt, values.closesAt)) {
      setError("Час завершення має бути пізніше часу відкриття.");
      return false;
    }
    setBusy(true); setError(""); setNotice("");
    const result = await updateAssignmentWindow(client, assignmentId, {
      opensAt: fromDateTimeLocal(values.opensAt),
      closesAt: fromDateTimeLocal(values.closesAt),
      allowRetries: values.allowRetries,
    });
    setBusy(false);
    if (!result.ok) { setError(mutationMessage(result.reason)); return false; }
    setNotice("Параметри призначення оновлено.");
    await loadAssignments();
    return true;
  }

  async function cancelAssignment(assignment: AssignmentRow) {
    const className = classFromRelation(assignment.classes)?.name ?? "цього класу";
    if (!window.confirm(`Скасувати призначення тесту класу «${className}»? Якщо учні вже почали спроби, база може заборонити видалення.`)) return;
    setBusy(true); setError(""); setNotice("");
    const result = await deleteAssignment(client, assignment.id);
    setBusy(false);
    if (!result.ok) { setError(mutationMessage(result.reason)); return; }
    setNotice("Призначення скасовано.");
    await loadAssignments();
  }

  const assignedClassIds = new Set(assignments.map((item) => item.class_id));
  const availableClasses = classes.filter((item) => !assignedClassIds.has(item.id));

  return <section className="assignment-panel" aria-labelledby="assignment-panel-title">
    <div className="assignment-panel-heading">
      <div><div className="eyebrow muted">ПУБЛІКАЦІЯ Й ДОСТУП</div><h3 id="assignment-panel-title">{template.title}</h3><p>{template.grade_level} клас · тест {status === "published" ? "опублікований" : "у чернетці"}</p></div>
      <button className="assignment-close" type="button" onClick={onClose} aria-label="Закрити керування тестом">×</button>
    </div>

    {status === "draft" ? <div className="assignment-publish">
      <h4>Перед публікацією</h4>
      <p>Опублікований тест і його запитання не можна редагувати. Щоб внести зміни пізніше, створіть окрему копію тесту.</p>
      <fieldset className="assignment-mode">
        <legend>РЕЖИМ ПРОХОДЖЕННЯ</legend>
        <label><input type="radio" name={`mode-${template.id}`} value="practice" checked={mode === "practice"} disabled={busy} onChange={() => setMode("practice")} /><span><strong>Тренування</strong><small>Учень бачить правильність відповіді після кожного запитання.</small></span></label>
        <label><input type="radio" name={`mode-${template.id}`} value="graded" checked={mode === "graded"} disabled={busy} onChange={() => setMode("graded")} /><span><strong>Оцінювання</strong><small>Правильність і результат відкриваються після завершення тесту.</small></span></label>
      </fieldset>
      {editorHasUnsavedChanges && <p className="assignment-help" role="status">Є незбережені зміни в редакторі. Закрийте це вікно, збережіть або скасуйте їх перед публікацією.</p>}
      <button className="primary-button" type="button" disabled={busy || editorHasUnsavedChanges} onClick={() => void publish()}>{busy ? "Публікуємо…" : "Опублікувати тест"}</button>
    </div> : <>
      <p className="assignment-mode-summary">Режим: <strong>{mode === "practice" ? "Тренування" : "Оцінювання"}</strong> · {mode === "practice" ? "підказка після кожної відповіді" : "результат після завершення"}</p>
      <form className="assignment-create" onSubmit={(event) => void assign(event)}>
        <h4>Призначити класу</h4>
        {loading ? <p className="assignment-empty" role="status">Завантажуємо доступні класи й призначення…</p> : availableClasses.length ? <>
          <label className="field-label">КЛАС<select value={classId} disabled={busy} onChange={(event) => setClassId(event.target.value)}>{availableClasses.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
          <div className="assignment-date-grid">
            <label className="field-label">ВІДКРИВАЄТЬСЯ<input type="datetime-local" value={opensAt} onChange={(event) => setOpensAt(event.target.value)} disabled={busy} /></label>
            <label className="field-label">ЗАКРИВАЄТЬСЯ<input type="datetime-local" value={closesAt} onChange={(event) => setClosesAt(event.target.value)} disabled={busy} /></label>
          </div>
          <label className="assignment-retry"><input type="checkbox" checked={allowRetries} disabled={busy} onChange={(event) => setAllowRetries(event.target.checked)} />Дозволити повторну спробу</label>
          <small className="assignment-help">Залиште дату порожньою, якщо завдання не має відповідної часової межі.</small>
          <button className="primary-button" type="submit" disabled={busy || loading}>{busy ? "Призначаємо…" : "Призначити тест"}</button>
        </> : <p className="assignment-empty">Немає доступного класу цього предмета й рівня, або тест уже призначено всім відповідним класам.</p>}
      </form>
      <div className="assignment-list"><h4>Призначення класам</h4>
        {loading ? <p className="assignment-empty" role="status">Завантажуємо призначення…</p> : assignments.length ? assignments.map((item) => <AssignmentEditor key={item.id} assignment={item} className={classFromRelation(item.classes)?.name ?? "Клас"} busy={busy} onSave={saveWindow} onCancel={() => void cancelAssignment(item)} />) : <p className="assignment-empty">Тест ще не призначено жодному класу.</p>}
      </div>
    </>}
    {error && <p className="template-error" role="alert">{error}</p>}
    {notice && <p className="template-notice" role="status">{notice}</p>}
  </section>;
}

function AssignmentEditor({ assignment, className, busy, onSave, onCancel }: {
  assignment: AssignmentRow;
  className: string;
  busy: boolean;
  onSave: (assignmentId: string, values: { opensAt: string; closesAt: string; allowRetries: boolean }) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [opensAt, setOpensAt] = useState(toDateTimeLocal(assignment.opens_at));
  const [closesAt, setClosesAt] = useState(toDateTimeLocal(assignment.closes_at));
  const [allowRetries, setAllowRetries] = useState(assignment.allow_retries);
  useEffect(() => {
    setOpensAt(toDateTimeLocal(assignment.opens_at));
    setClosesAt(toDateTimeLocal(assignment.closes_at));
    setAllowRetries(assignment.allow_retries);
  }, [assignment.opens_at, assignment.closes_at, assignment.allow_retries]);
  const changed = opensAt !== toDateTimeLocal(assignment.opens_at) || closesAt !== toDateTimeLocal(assignment.closes_at) || allowRetries !== assignment.allow_retries;
  return <article className="assignment-item">
    <div className="assignment-item-heading"><strong>{className}</strong><small>Призначено {new Date(assignment.created_at).toLocaleDateString("uk-UA")}</small></div>
    <div className="assignment-date-grid">
      <label className="field-label">ВІДКРИВАЄТЬСЯ<input type="datetime-local" value={opensAt} onChange={(event) => setOpensAt(event.target.value)} disabled={busy} /></label>
      <label className="field-label">ЗАКРИВАЄТЬСЯ<input type="datetime-local" value={closesAt} onChange={(event) => setClosesAt(event.target.value)} disabled={busy} /></label>
    </div>
    <label className="assignment-retry"><input type="checkbox" checked={allowRetries} disabled={busy} onChange={(event) => setAllowRetries(event.target.checked)} />Дозволити повторну спробу</label>
    <div className="assignment-item-actions"><button type="button" disabled={busy || !changed} onClick={() => void onSave(assignment.id, { opensAt, closesAt, allowRetries })}>Зберегти параметри</button><button type="button" className="danger" disabled={busy} onClick={onCancel}>Скасувати призначення</button></div>
  </article>;
}

import { useCallback, useEffect, useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AssessmentSettings, FunctionContracts } from "../../contracts/api";
import { apiErrorMessage, invokeFunction } from "../lib/function-api";
import { buildBulkUpdateRequest, bankErrorMessage, filterBankQuestions, summarizeBank } from "./bank-api.js";
import type { BankQuestionRow } from "./bank-api.js";

interface Props {
  client: SupabaseClient;
  template: { id: string; title: string; settings?: AssessmentSettings | null };
  onClose: () => void;
  onEditQuestion: (questionId: string) => void;
}

type DbQuestion = { id: string; position: number; prompt: unknown; difficulty: number | null; points: number; time_limit_seconds: number | null };
type Request = FunctionContracts["bulk-update-questions"]["request"];
type BankRow = BankQuestionRow & DbQuestion;

function promptText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt;
  if (prompt && typeof prompt === "object" && "text" in prompt && typeof (prompt as { text?: unknown }).text === "string") return (prompt as { text: string }).text;
  return "Запитання";
}

export function BankQuestionManager({ client, template, onClose, onEditQuestion }: Props) {
  const [questions, setQuestions] = useState<BankRow[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [level, setLevel] = useState<number | "all">("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [difficulty, setDifficulty] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [points, setPoints] = useState("1");
  const [timeLimit, setTimeLimit] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const expected = template.settings?.pool?.levelCounts ?? [0, 0, 0, 0, 0];
  const levelCounts = useMemo(() => {
    const counts = [0, 0, 0, 0, 0];
    for (const question of questions) if (question.difficulty && question.difficulty >= 1 && question.difficulty <= 5) counts[question.difficulty - 1] += 1;
    return counts as [number, number, number, number, number];
  }, [questions]);
  const summary = summarizeBank(levelCounts, expected);
  const filtered = useMemo(() => filterBankQuestions(questions, { level, search, page, pageSize: 25 }), [questions, level, search, page]);
  const visibleIds = filtered.items.map((question) => question.id);
  const selectedVisible = visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id));

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const all: DbQuestion[] = [];
      const pageSize = 200;
      for (let offset = 0; ; offset += pageSize) {
        const { data, error: queryError } = await client.from("assessment_questions")
          .select("id,position,prompt,difficulty,points,time_limit_seconds")
          .eq("template_id", template.id)
          .order("position", { ascending: true })
          .range(offset, offset + pageSize - 1);
        if (queryError) throw queryError;
        const rows = (data ?? []) as DbQuestion[];
        all.push(...rows);
        if (rows.length < pageSize) break;
      }
      setQuestions(all.map((row) => ({ ...row, promptText: promptText(row.prompt), timeLimitSeconds: row.time_limit_seconds })));
      setSelected([]);
    } catch {
      setError("Не вдалося завантажити банк. Перевірте з’єднання й наявність функцій G11.");
    } finally {
      setLoading(false);
    }
  }, [client, template.id]);

  useEffect(() => { void reload(); }, [reload]);

  const filteredAll = useMemo(() => filterBankQuestions(questions, { level, search, page: 1, pageSize: Math.max(1, questions.length) }).items, [questions, level, search]);
  function toggleQuestion(id: string) {
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }
  function toggleVisible() {
    setSelected((current) => selectedVisible ? current.filter((id) => !visibleIds.includes(id)) : [...new Set([...current, ...visibleIds])]);
  }
  function selectAllFiltered() { setSelected(filteredAll.map((question) => question.id)); }

  async function updateSelected(update: NonNullable<Request["update"]>) {
    if (!selected.length || busy) return;
    setBusy(true); setError(""); setNotice("");
    let request: Request;
    try { request = buildBulkUpdateRequest(template.id, selected, update); }
    catch { setError("Не вдалося сформувати запит для масової зміни."); setBusy(false); return; }
    const result = await invokeFunction(client, "bulk-update-questions", request);
    setBusy(false);
    if (!result.ok) { setError(bankErrorMessage(result.error.code) ?? apiErrorMessage(result.error.code)); return; }
    setNotice(`Оновлено запитань: ${result.data.affected}.`);
    await reload();
  }

  async function deleteSelected() {
    if (!selected.length || busy) return;
    if (!window.confirm(`Видалити вибрані запитання (${selected.length})? Цю дію не можна скасувати.`)) return;
    setBusy(true); setError(""); setNotice("");
    const request = buildBulkUpdateRequest(template.id, selected, { delete: true });
    const result = await invokeFunction(client, "bulk-update-questions", request);
    setBusy(false);
    if (!result.ok) { setError(bankErrorMessage(result.error.code) ?? apiErrorMessage(result.error.code)); return; }
    setNotice(`Видалено запитань: ${result.data.affected}.`);
    await reload();
  }

  return <div className="bank-manager-backdrop">
    <section className="bank-manager" role="dialog" aria-modal="true" aria-labelledby="bank-manager-title">
      <header className="bank-manager-heading"><div><div className="eyebrow muted">РЕДАКТОР БАНКУ</div><h3 id="bank-manager-title">{template.title}</h3></div><button type="button" className="bank-dialog-close" aria-label="Закрити редактор банку" onClick={onClose} disabled={busy}>×</button></header>
      <div className="bank-level-summary" aria-label="Кількість запитань за рівнями">{summary.have.map((count, index) => <div key={index} className={summary.missing[index] ? "shortage" : ""}><span>Рівень {index + 1}</span><strong>{count} / {summary.need[index]}</strong>{summary.missing[index] > 0 && <small>бракує {summary.missing[index]}</small>}</div>)}</div>
      {!summary.complete && <p className="bank-shortage" role="status">Публікація буде недоступна, доки в банку не вистачатиме запитань потрібного рівня.</p>}
      <div className="bank-filter-row">
        <label className="field-label">РІВЕНЬ<select value={level} onChange={(event) => { setLevel(event.target.value === "all" ? "all" : Number(event.target.value)); setPage(1); }} disabled={busy}><option value="all">Усі рівні</option>{[1,2,3,4,5].map((value) => <option key={value} value={value}>Рівень {value}</option>)}</select></label>
        <label className="field-label">ПОШУК ЗА ТЕКСТОМ<input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Знайти запитання…" disabled={busy} /></label>
      </div>
      <div className="bank-selection-tools"><label><input type="checkbox" checked={selectedVisible} onChange={toggleVisible} disabled={busy || !visibleIds.length} /> Обрати всі на сторінці</label><button type="button" className="text-button" onClick={selectAllFiltered} disabled={busy || !filteredAll.length}>Обрати всі за фільтром ({filteredAll.length})</button><span>Вибрано: {selected.length}</span></div>
      {selected.length > 0 && <fieldset className="bank-bulk-actions" disabled={busy}><legend>МАСОВІ ДІЇ</legend>
        <label>Рівень<select value={difficulty} onChange={(event) => setDifficulty(Number(event.target.value) as 1 | 2 | 3 | 4 | 5)}>{[1,2,3,4,5].map((value) => <option key={value} value={value}>{value}</option>)}</select></label><button type="button" onClick={() => void updateSelected({ difficulty })}>Змінити рівень</button>
        <label>Бали<input type="number" min="0.01" max="100" step="0.01" value={points} onChange={(event) => setPoints(event.target.value)} /></label><button type="button" onClick={() => void updateSelected({ points: Number(points) })}>Змінити бали</button>
        <label>Час, сек.<input type="number" min="1" max="3600" step="1" value={timeLimit} placeholder="Без змін" onChange={(event) => setTimeLimit(event.target.value)} /></label><button type="button" disabled={!timeLimit} onClick={() => void updateSelected({ timeLimitSeconds: Number(timeLimit) })}>Змінити час</button><button type="button" onClick={() => void updateSelected({ timeLimitSeconds: null })}>Прибрати обмеження часу</button>
        <button type="button" className="danger" onClick={() => void deleteSelected()}>Видалити вибрані</button>
      </fieldset>}
      {error && <p className="bank-error" role="alert">{error}</p>}{notice && <p className="bank-notice" role="status">{notice}</p>}
      {loading ? <p role="status" className="bank-manager-state">Завантажуємо банк запитань…</p> : filtered.items.length ? <div className="bank-question-list">{filtered.items.map((question) => <article className="bank-question-row" key={question.id}>
        <label className="bank-question-check"><input type="checkbox" checked={selected.includes(question.id)} onChange={() => toggleQuestion(question.id)} disabled={busy} /><span className="sr-only">Вибрати запитання {question.position}</span></label>
        <div className="bank-question-main"><strong>{question.promptText}</strong><small>Рівень {question.difficulty ?? "не задано"} · {question.points} б. · {question.timeLimitSeconds ? `${question.timeLimitSeconds} с` : "без обмеження часу"}</small></div>
        <button type="button" className="bank-edit-question" onClick={() => onEditQuestion(question.id)} disabled={busy}>Редагувати</button>
      </article>)}</div> : <p className="bank-manager-state">За цим фільтром запитань немає.</p>}
      {!loading && filtered.pageCount > 1 && <nav className="bank-pagination" aria-label="Сторінки банку"><button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1 || busy}>← Попередня</button><span>Сторінка {filtered.page} з {filtered.pageCount}</span><button type="button" onClick={() => setPage((value) => Math.min(filtered.pageCount, value + 1))} disabled={page >= filtered.pageCount || busy}>Наступна →</button></nav>}
      <footer className="bank-manager-footer"><button type="button" className="editor-secondary" onClick={() => void reload()} disabled={loading || busy}>Оновити</button><button type="button" className="primary-button" onClick={onClose} disabled={busy}>Готово</button></footer>
    </section>
  </div>;
}

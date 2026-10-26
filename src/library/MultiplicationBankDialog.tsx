import { useMemo, useState } from "react";
import type { AssessmentMode, FunctionContracts } from "../../contracts/api";
import type { supabase } from "../lib/supabase";
import { apiErrorMessage, invokeFunction } from "../lib/function-api";
import { DEFAULT_BANK_LEVEL_COUNTS, bankErrorMessage, buildBankRequest, normalizeLevelCounts } from "./bank-api.js";

type Client = NonNullable<typeof supabase>;
type Request = FunctionContracts["generate-multiplication-bank"]["request"];
type Data = FunctionContracts["generate-multiplication-bank"]["data"];
type Subject = { id: string; code: string; name: string };

interface Props {
  client: Client;
  subject: Subject;
  grade: number;
  onClose: () => void;
  onCreated: (data: Data, requestedGrade: number) => void;
}

export function MultiplicationBankDialog({ client, subject, grade, onClose, onCreated }: Props) {
  const [gradeLevel, setGradeLevel] = useState(grade);
  const [mode, setMode] = useState<AssessmentMode>("practice");
  const [title, setTitle] = useState("");
  const [counts, setCounts] = useState<number[]>([...DEFAULT_BANK_LEVEL_COUNTS]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const total = counts.reduce((sum, value) => sum + (Number(value) || 0), 0);
  const validCounts = useMemo(() => normalizeLevelCounts(counts), [counts]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !validCounts) return;
    setBusy(true);
    setError("");
    let request: Request;
    try {
      request = buildBankRequest({ subjectId: subject.id, gradeLevel, mode, title, levelCounts: counts });
    } catch {
      setError("Загальна кількість запитань має бути від 1 до 100.");
      setBusy(false);
      return;
    }
    const result = await invokeFunction(client, "generate-multiplication-bank", request);
    setBusy(false);
    if (!result.ok) {
      setError(bankErrorMessage(result.error.code) ?? apiErrorMessage(result.error.code));
      return;
    }
    onCreated(result.data, gradeLevel);
  }

  const modeNames = { practice: "Тренування", graded: "Оцінювання" };
  return <div className="bank-dialog-backdrop">
    <section className="bank-dialog" role="dialog" aria-modal="true" aria-labelledby="bank-dialog-title">
      <header className="bank-dialog-heading"><div><div className="eyebrow muted">БАНК ЗАПИТАНЬ</div><h3 id="bank-dialog-title">Створити тест BIG таблиця множення</h3></div><button type="button" className="bank-dialog-close" aria-label="Закрити діалог" onClick={onClose} disabled={busy}>×</button></header>
      <p>Створимо чернетку з банком прикладів. Кожна спроба отримає вибірку за рівнями складності.</p>
      <form onSubmit={(event) => void submit(event)}>
        <div className="bank-dialog-fields">
          <label className="field-label">КЛАС<select value={gradeLevel} onChange={(event) => setGradeLevel(Number(event.target.value))} disabled={busy}>{Array.from({ length: 11 }, (_, i) => i + 1).map((value) => <option key={value} value={value}>{value} клас</option>)}</select></label>
          <label className="field-label">НАЗВА<input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} placeholder="BIG таблиця множення" disabled={busy} /></label>
        </div>
        <fieldset className="bank-mode-fieldset"><legend>РЕЖИМ</legend>{(Object.keys(modeNames) as AssessmentMode[]).map((value) => <label key={value}><input type="radio" name="bank-mode" checked={mode === value} onChange={() => setMode(value)} disabled={busy} />{modeNames[value]}</label>)}</fieldset>
        <fieldset className="bank-count-fieldset"><legend>ЗАПИТАННЯ ЗА РІВНЕМ СКЛАДНОСТІ</legend>
          {counts.map((value, index) => <label className="bank-count-row" key={index}><span>Рівень {index + 1}</span><input type="number" min="0" max="100" step="1" inputMode="numeric" value={value} onChange={(event) => setCounts((current) => current.map((item, i) => i === index ? Number(event.target.value) : item))} disabled={busy} aria-label={`Кількість запитань рівня ${index + 1}`} /></label>)}
          <p className={validCounts ? "bank-count-total" : "bank-count-total invalid"} aria-live="polite">Усього: <strong>{total}</strong> / 100. Потрібно від 1 до 100 запитань.</p>
        </fieldset>
        {error && <p className="bank-error" role="alert">{error}</p>}
        <footer className="bank-dialog-actions"><button type="button" className="editor-secondary" onClick={onClose} disabled={busy}>Скасувати</button><button type="submit" className="primary-button" disabled={busy || !validCounts}>{busy ? "Створюємо…" : "Створити банк"}</button></footer>
      </form>
    </section>
  </div>;
}

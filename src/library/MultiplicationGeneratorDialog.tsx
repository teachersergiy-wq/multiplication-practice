import { useEffect, useMemo, useRef, useState } from "react";
import type { AssessmentMode, FunctionContracts, MultiplicationLevelConfig } from "../../contracts/api";
import type { supabase } from "../lib/supabase";
import { apiErrorMessage, invokeFunction } from "../lib/function-api";
import { buildGeneratorRequest, generateTest, generatorErrorMessage, selectApplicableConfig } from "./generator-api.js";
import type { ConfigRow, GenerateData } from "./generator-api.js";

type Client = NonNullable<typeof supabase>;
type Request = FunctionContracts["generate-multiplication-test"]["request"];
type Subject = { id: string; code: string; name: string };

interface Props {
  client: Client;
  subject: Subject;
  grade: number;
  onClose: () => void;
  onCreated: (draft: GenerateData, requestedGrade: number) => void;
}

export function MultiplicationGeneratorDialog({ client, subject, grade, onClose, onCreated }: Props) {
  const dialogRef = useRef<HTMLElement>(null);
  const busyRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const [gradeLevel, setGradeLevel] = useState(grade);
  const [levelNumber, setLevelNumber] = useState(1);
  const [mode, setMode] = useState<AssessmentMode>("practice");
  const [title, setTitle] = useState("");
  const [configs, setConfigs] = useState<ConfigRow[]>([]);
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  busyRef.current = busy;
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) onCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    let active = true;
    setLoadingConfig(true);
    void (async () => {
      try {
        const { data, error: queryError } = await client.from("multiplication_level_configs")
          .select("grade_level,level_number,question_count,seconds_per_question,max_errors,pass_percent,min_factor,max_factor,active")
          .eq("subject_id", subject.id)
          .eq("level_number", levelNumber)
          .lte("grade_level", gradeLevel)
          .eq("active", true)
          .order("grade_level", { ascending: false });
        if (!active) return;
        if (queryError) {
          setConfigs([]);
          setError("Не вдалося завантажити налаштування множення. Перевірте з’єднання й повторіть спробу.");
        } else {
          setConfigs((data ?? []) as ConfigRow[]);
          setError("");
        }
      } catch {
        if (active) {
          setConfigs([]);
          setError("Не вдалося завантажити налаштування множення. Перевірте з’єднання й повторіть спробу.");
        }
      } finally {
        if (active) setLoadingConfig(false);
      }
    })();
    return () => { active = false; };
  }, [client, gradeLevel, levelNumber, subject.id]);

  const config = useMemo(() => selectApplicableConfig(configs, gradeLevel, levelNumber), [configs, gradeLevel, levelNumber]);
  const modeLabels = { practice: "Тренування", graded: "Оцінювання" };
  const visibleConfig: MultiplicationLevelConfig | null = config ? {
    gradeLevel: Number(config.grade_level),
    levelNumber: Number(config.level_number),
    questionCount: Number(config.question_count),
    secondsPerQuestion: Number(config.seconds_per_question),
    maxErrors: Number(config.max_errors),
    passPercent: Number(config.pass_percent),
    minFactor: Number(config.min_factor),
    maxFactor: Number(config.max_factor),
  } : null;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !config) return;
    setBusy(true);
    setError("");
    const request: Request = buildGeneratorRequest({ subjectId: subject.id, gradeLevel, levelNumber, mode, title });
    const callFunction = (name: "generate-multiplication-test", body: Request) => invokeFunction(client, name, body);
    const result = await generateTest(request, callFunction);
    setBusy(false);
    if (!result.ok) {
      setError(generatorErrorMessage(result.error.code) ?? apiErrorMessage(result.error.code));
      return;
    }
    const data = result.data;
    onCreated(data, gradeLevel);
  }

  return <div className="multiplication-generator-backdrop">
    <section ref={dialogRef} className="multiplication-generator-dialog" role="dialog" aria-modal="true" aria-labelledby="multiplication-generator-title" tabIndex={-1}>
      <header className="multiplication-generator-heading">
        <div><div className="eyebrow muted">ГЕНЕРАТОР МНОЖЕННЯ</div><h3 id="multiplication-generator-title">Згенерувати тест з множення</h3></div>
        <button type="button" className="multiplication-generator-close" aria-label="Закрити діалог" onClick={onClose}>×</button>
      </header>
      <p className="multiplication-generator-description">Створимо чернетку з числовими питаннями. Перед публікацією її можна буде відредагувати.</p>
      <form className="multiplication-generator-form" onSubmit={(event) => void submit(event)}>
        <label className="field-label">КЛАС
          <select value={gradeLevel} onChange={(event) => setGradeLevel(Number(event.target.value))} disabled={busy}>
            {Array.from({ length: 11 }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value} клас</option>)}
          </select>
        </label>
        <label className="field-label">РІВЕНЬ МНОЖЕННЯ
          <select value={levelNumber} onChange={(event) => setLevelNumber(Number(event.target.value))} disabled={busy}>
            {Array.from({ length: 5 }, (_, index) => index + 1).map((value) => <option key={value} value={value}>Рівень {value}</option>)}
          </select>
        </label>
        <fieldset className="multiplication-generator-modes">
          <legend>РЕЖИМ</legend>
          {(Object.keys(modeLabels) as AssessmentMode[]).map((value) => <label key={value}><input type="radio" name="generator-mode" value={value} checked={mode === value} onChange={() => setMode(value)} disabled={busy} />{modeLabels[value]}</label>)}
        </fieldset>
        <label className="field-label">НАЗВА (НЕОБОВ’ЯЗКОВО)
          <input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} placeholder={`Множення: рівень ${levelNumber}`} disabled={busy} />
        </label>

        <section className="multiplication-generator-config" aria-live="polite" aria-label="Налаштування тесту">
          {loadingConfig ? <p role="status">Завантажуємо налаштування…</p> : visibleConfig ? <>
            {visibleConfig.gradeLevel !== gradeLevel && <p className="multiplication-generator-fallback">Для цього класу використано налаштування {visibleConfig.gradeLevel} класу.</p>}
            <h4>Параметри тесту</h4>
            <dl>
              <div><dt>Запитань</dt><dd>{visibleConfig.questionCount}</dd></div>
              <div><dt>Час на запитання</dt><dd>{visibleConfig.secondsPerQuestion} с</dd></div>
              <div><dt>Допустимо помилок</dt><dd>{visibleConfig.maxErrors}</dd></div>
              <div><dt>Для проходження</dt><dd>{visibleConfig.passPercent}%</dd></div>
              <div><dt>Множники</dt><dd>{visibleConfig.minFactor}–{visibleConfig.maxFactor}</dd></div>
            </dl>
          </> : <p className="multiplication-generator-config-empty">Для цього класу й рівня налаштувань поки немає.</p>}
        </section>
        {error && <p className="multiplication-generator-error" role="alert">{error}</p>}
        <div className="multiplication-generator-actions">
          <button type="button" onClick={onClose} disabled={busy}>Скасувати</button>
          <button className="primary-button" type="submit" disabled={busy || loadingConfig || !config} aria-busy={busy}>{busy ? "Генеруємо…" : "Створити чернетку й відкрити"}</button>
        </div>
      </form>
    </section>
  </div>;
}

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AuthoredQuestion, AssessmentStatus, QuestionType, StoredAuthoredQuestion } from "../../contracts/api";
import { LIMITS } from "../../contracts/api";
import { questionTypeLabels } from "../domain";
import { isAuthoredQuestion, validateAuthoredQuestion } from "../question-validation";
import { supabase } from "../lib/supabase";
import { apiErrorMessage, invokeFunction } from "../lib/function-api";
import { partialCreditHint } from "../scoring.js";
import { deleteQuestionRequest, getDraftRequest, reorderQuestionsRequest, upsertQuestionRequest } from "./editor-api.js";

const questionTypes: QuestionType[] = ["true_false", "single_choice", "multiple_choice", "ordering", "matching", "numeric", "short_answer"];
const makeId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
type TextItem = { id: string; value: string };
type MatchItem = { id: string; left: string; right: string };
const textItems = (count: number): TextItem[] => Array.from({ length: count }, () => ({ id: makeId(), value: "" }));
const matchItems = (count: number): MatchItem[] => Array.from({ length: count }, () => ({ id: makeId(), left: "", right: "" }));
const moveItem = <T,>(items: T[], index: number, direction: -1 | 1): T[] => {
  const target = index + direction;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
};

export function QuestionEditor({ selectedDraft, focusQuestionId, onUnsavedChangesChange }: {
  selectedDraft?: { id: string; title: string } | null;
  focusQuestionId?: string | null;
  onUnsavedChangesChange?: (draftId: string | null, dirty: boolean) => void;
}) {
  const [type, setType] = useState<QuestionType>("numeric");
  const [promptText, setPromptText] = useState("");
  const [points, setPoints] = useState("1");
  const [timeLimit, setTimeLimit] = useState("");
  const [options, setOptions] = useState<TextItem[]>(textItems(4));
  const [correctIndex, setCorrectIndex] = useState<number | null>(null);
  const [correctIndexes, setCorrectIndexes] = useState<number[]>([]);
  const [items, setItems] = useState<TextItem[]>(textItems(3));
  const [pairs, setPairs] = useState<MatchItem[]>(matchItems(2));
  const [correctBoolean, setCorrectBoolean] = useState<boolean | null>(null);
  const [numericValue, setNumericValue] = useState("");
  const [tolerance, setTolerance] = useState("");
  const [accepted, setAccepted] = useState<TextItem[]>(textItems(1));
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [questions, setQuestions] = useState<StoredAuthoredQuestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draftStatus, setDraftStatus] = useState<AssessmentStatus>("draft");
  const [isPool, setIsPool] = useState(false);
  const [difficulty, setDifficulty] = useState("1");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const inputRefs = useRef(new Map<string, HTMLInputElement>());

  function markFormDirty() {
    onUnsavedChangesChange?.(selectedDraft?.id ?? null, true);
  }

  function clearFormDirty() {
    onUnsavedChangesChange?.(selectedDraft?.id ?? null, false);
  }

  useEffect(() => {
    let active = true;
    setQuestions([]);
    setEditingId(null);
    onUnsavedChangesChange?.(selectedDraft?.id ?? null, false);
    setNotice("");
    setErrors([]);
    if (!selectedDraft || !supabase) {
      setDraftStatus("draft");
      setIsPool(false);
      setLoading(false);
      return () => { active = false; };
    }
    setLoading(true);
    void invokeFunction(supabase, "get-assessment-draft", getDraftRequest(selectedDraft.id)).then((result) => {
      if (!active) return;
      if (!result.ok) {
        setErrors([apiErrorMessage(result.error.code)]);
        setLoading(false);
        return;
      }
      setQuestions(result.data.questions);
      setIsPool(Boolean(result.data.template.settings?.pool));
      setDraftStatus(result.data.template.status);
      const focused = focusQuestionId ? result.data.questions.find((question) => question.id === focusQuestionId) : null;
      if (focused) loadQuestion(focused);
      setLoading(false);
    });
    return () => { active = false; };
  }, [focusQuestionId, selectedDraft?.id]);

  function setInputRef(id: string, element: HTMLInputElement | null) {
    if (element) inputRefs.current.set(id, element);
    else inputRefs.current.delete(id);
  }

  function focusAfterChange(id: string | undefined) {
    if (id) requestAnimationFrame(() => inputRefs.current.get(id)?.focus());
  }

  function focusNeighbor(rows: { id: string }[], index: number) {
    focusAfterChange(rows[index + 1]?.id ?? rows[index - 1]?.id);
  }

  function changeType(next: QuestionType) {
    setType(next); setErrors([]); setNotice("");
    if (next === "single_choice") { setOptions(textItems(4)); setCorrectIndexes([]); setCorrectIndex(null); }
    if (next === "multiple_choice") { setOptions(textItems(3)); setCorrectIndexes([]); }
    if (next === "ordering") setItems(textItems(3));
    if (next === "matching") setPairs(matchItems(2));
    if (next === "short_answer") setAccepted(textItems(1));
  }

  function loadQuestion(question: StoredAuthoredQuestion) {
    setEditingId(question.id);
    setType(question.type);
    setPromptText(question.promptText);
    setPoints(String(question.points));
    setTimeLimit(question.timeLimitSeconds == null ? "" : String(question.timeLimitSeconds));
    setDifficulty(String(question.difficulty ?? 1));
    if (question.type === "true_false") setCorrectBoolean(question.correct);
    if (question.type === "single_choice") { setOptions(question.options.map((value) => ({ id: makeId(), value }))); setCorrectIndex(question.correctIndex); }
    if (question.type === "multiple_choice") { setOptions(question.options.map((value) => ({ id: makeId(), value }))); setCorrectIndexes(question.correctIndexes); }
    if (question.type === "ordering") setItems(question.itemsInCorrectOrder.map((value) => ({ id: makeId(), value })));
    if (question.type === "matching") setPairs(question.pairs.map((pair) => ({ id: makeId(), ...pair })));
    if (question.type === "numeric") { setNumericValue(String(question.value)); setTolerance(question.tolerance == null ? "" : String(question.tolerance)); }
    if (question.type === "short_answer") { setAccepted(question.accepted.map((value) => ({ id: makeId(), value }))); setCaseSensitive(question.caseSensitive ?? false); }
    setErrors([]); setNotice("Питання завантажено для редагування.");
    document.getElementById("question-editor")?.scrollIntoView({ behavior: "smooth" });
  }

  function resetForm() {
    clearFormDirty();
    setEditingId(null); setType("numeric"); setPromptText(""); setPoints("1"); setTimeLimit("");
    setOptions(textItems(4)); setCorrectIndex(null); setCorrectIndexes([]); setItems(textItems(3));
    setPairs(matchItems(2)); setCorrectBoolean(null); setNumericValue(""); setTolerance("");
    setAccepted(textItems(1)); setCaseSensitive(false); setDifficulty("1");
  }

  function makeQuestion(): unknown {
    const common = { promptText, points: Number(points), ...(timeLimit ? { timeLimitSeconds: Number(timeLimit) } : {}), ...(isPool ? { difficulty: Number(difficulty) } : {}) };
    switch (type) {
      case "true_false": return { ...common, type, correct: correctBoolean };
      case "single_choice": return { ...common, type, options: options.map((item) => item.value), correctIndex };
      case "multiple_choice": return { ...common, type, options: options.map((item) => item.value), correctIndexes };
      case "ordering": return { ...common, type, itemsInCorrectOrder: items.map((item) => item.value) };
      case "matching": return { ...common, type, pairs: pairs.map(({ left, right }) => ({ left, right })) };
      case "numeric": return { ...common, type, value: numericValue.trim() ? Number(numericValue) : Number.NaN, ...(tolerance ? { tolerance: Number(tolerance) } : {}) };
      case "short_answer": return { ...common, type, accepted: accepted.map((item) => item.value), caseSensitive };
    }
  }

  async function saveQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const candidate = makeQuestion();
    const validationErrors = validateAuthoredQuestion(candidate);
    if (isPool && !/^[1-5]$/.test(difficulty)) validationErrors.push("Для запитання пулу оберіть рівень складності від 1 до 5.");
    setErrors(validationErrors); setNotice("");
    if (!isAuthoredQuestion(candidate)) return;
    if (!selectedDraft || !supabase) {
      setQuestions((current) => [...current, { ...candidate, id: makeId(), position: current.length }]);
      setNotice("Запитання додано лише до цієї демо-сесії.");
      setPromptText("");
      clearFormDirty();
      return;
    }
    setSaving(true);
    const result = await invokeFunction(supabase, "upsert-question", upsertQuestionRequest(selectedDraft.id, editingId, candidate));
    if (!result.ok) {
      setErrors([apiErrorMessage(result.error.code)]);
      setSaving(false);
      return;
    }
    const saved: StoredAuthoredQuestion = { ...candidate, id: result.data.questionId, position: editingId ? (questions.find((item) => item.id === editingId)?.position ?? questions.length) : questions.length };
    setQuestions((current) => editingId
      ? current.map((item) => item.id === editingId ? saved : item)
      : [...current, saved]);
    setNotice(editingId ? "Зміни збережено." : "Запитання збережено в чернетці.");
    resetForm();
    setSaving(false);
  }

  async function deleteQuestion(question: StoredAuthoredQuestion) {
    if (!window.confirm(`Видалити запитання «${question.promptText}»?`)) return;
    if (!selectedDraft || !supabase) { setQuestions((current) => current.filter((item) => item.id !== question.id)); return; }
    setSaving(true);
    const result = await invokeFunction(supabase, "delete-question", deleteQuestionRequest(question.id));
    if (!result.ok) setErrors([apiErrorMessage(result.error.code)]);
    else { setQuestions((current) => current.filter((item) => item.id !== question.id).map((item, position) => ({ ...item, position }))); setNotice("Запитання видалено."); }
    setSaving(false);
  }

  async function moveQuestion(question: StoredAuthoredQuestion, direction: -1 | 1) {
    const index = questions.findIndex((item) => item.id === question.id);
    const target = index + direction;
    if (target < 0 || target >= questions.length) return;
    const reordered = [...questions];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    if (selectedDraft && supabase) {
      setSaving(true);
      const result = await invokeFunction(supabase, "reorder-questions", reorderQuestionsRequest(selectedDraft.id, reordered.map((item) => item.id)));
      if (!result.ok) { setErrors([apiErrorMessage(result.error.code)]); setSaving(false); return; }
    }
    setQuestions(reordered.map((item, position) => ({ ...item, position })));
    setNotice("Порядок запитань оновлено.");
    setSaving(false);
  }

  function preview(question: AuthoredQuestion, previewId: string) {
    return <article className="question-preview" key={previewId}>
      <span className="question-preview-type">{questionTypeLabels[question.type]} · {question.points} б.{question.difficulty ? ` · рівень ${question.difficulty}` : ""}</span>
      <strong>{question.promptText}</strong>
      {partialCreditHint(question.type) && <p className="partial-credit-hint">{partialCreditHint(question.type)}</p>}
      {question.type === "true_false" && <p>Так &nbsp; / &nbsp; Ні</p>}
      {(question.type === "single_choice" || question.type === "multiple_choice") && <ol>{question.options.map((option, index) => <li key={`${previewId}-choice-${index}`}>{option}</li>)}</ol>}
      {question.type === "ordering" && <ol>{[...question.itemsInCorrectOrder].reverse().map((item, index) => <li key={`${previewId}-order-${index}`}>{item}</li>)}</ol>}
      {question.type === "matching" && <div className="preview-match-columns"><ul>{question.pairs.map((pair, index) => <li key={`${previewId}-left-${index}`}>{pair.left}</li>)}</ul><ul>{[...question.pairs].reverse().map((pair, index) => <li key={`${previewId}-right-${index}`}>{pair.right}</li>)}</ul></div>}
      {(question.type === "numeric" || question.type === "short_answer") && <p className="preview-response">Поле для відповіді учня</p>}
    </article>;
  }

  const bounds = type === "single_choice" ? LIMITS.singleChoiceOptions : type === "multiple_choice" ? LIMITS.multipleChoiceOptions : LIMITS.orderingItems;
  return (
    <section className="question-editor" id="question-editor">
      <div className="section-heading"><div><div className="eyebrow muted">КОНСТРУКТОР</div><h2>{selectedDraft ? `Редагування: ${selectedDraft.title}` : "Редактор запитань"}</h2></div><span className="section-aside">{!supabase ? "Демо-режим · дані лише в цій сесії" : !selectedDraft ? "Оберіть тест у бібліотеці" : draftStatus === "draft" ? "Чернетка збережеться на сервері" : "Опублікований тест · лише перегляд"}</span></div>
      {loading && <p className="question-notice" role="status">Завантажуємо питання чернетки…</p>}
      {errors.length > 0 && <ul className="question-errors" role="alert">{errors.map((error) => <li key={error}>{error}</li>)}</ul>}
      {supabase && !selectedDraft && <p className="question-preview-help">Виберіть чернетку у бібліотеці, щоб переглянути або редагувати її питання.</p>}
      <div className="question-editor-grid">
        {(!supabase || (selectedDraft && draftStatus === "draft" && !loading)) && <form className="question-form" onSubmit={saveQuestion} onChange={markFormDirty} onClick={(event) => {
          const button = (event.target as HTMLElement).closest("button");
          if (button?.type === "button" && !button.hasAttribute("data-dirty-ignore")) markFormDirty();
        }}>
          {saving && <p className="question-notice" role="status">Зберігаємо…</p>}
          <label className="field-label">ТИП ЗАПИТАННЯ
            <select value={type} disabled={saving} onChange={(event) => changeType(event.target.value as QuestionType)}>
              {questionTypes.map((item) => <option value={item} key={item}>{questionTypeLabels[item]}</option>)}
            </select>
          </label>
          <label className="field-label">ТЕКСТ ЗАПИТАННЯ
            <textarea required minLength={LIMITS.promptText.min} maxLength={LIMITS.promptText.max} value={promptText} onChange={(event) => setPromptText(event.target.value)} rows={3} />
            <small>{promptText.length}/{LIMITS.promptText.max}</small>
          </label>
          <div className="question-meta-fields">
            <label className="field-label">БАЛИ<input type="number" min={LIMITS.points.min} max={LIMITS.points.max} step="0.01" value={points} onChange={(event) => setPoints(event.target.value)} /></label>
            <label className="field-label">ЧАС, СЕК. — НЕОБОВ’ЯЗКОВО<input type="number" min={LIMITS.timeLimitSeconds.min} max={LIMITS.timeLimitSeconds.max} step="1" value={timeLimit} onChange={(event) => setTimeLimit(event.target.value)} /></label>
            {isPool && <label className="field-label">РІВЕНЬ СКЛАДНОСТІ<select required value={difficulty} onChange={(event) => setDifficulty(event.target.value)}>{[1,2,3,4,5].map((value) => <option key={value} value={value}>Рівень {value}</option>)}</select></label>}
          </div>
          {type === "true_false" && <fieldset className="question-fieldset"><legend>ПРАВИЛЬНА ВІДПОВІДЬ</legend>{([true, false] as const).map((value) => <label key={String(value)}><input type="radio" name="boolean-answer" checked={correctBoolean === value} onChange={() => setCorrectBoolean(value)} />{value ? "Так" : "Ні"}</label>)}</fieldset>}
          {(type === "single_choice" || type === "multiple_choice") && <fieldset className="question-fieldset"><legend>ВАРІАНТИ ТА ПРАВИЛЬНА ВІДПОВІДЬ</legend>
            {options.map((option, index) => <div className="editor-list-row" key={option.id}>
              <input type={type === "single_choice" ? "radio" : "checkbox"} name="choice-answer" aria-label={`Позначити варіант ${index + 1} правильним`} checked={type === "single_choice" ? correctIndex === index : correctIndexes.includes(index)} onChange={() => type === "single_choice" ? setCorrectIndex(index) : setCorrectIndexes((current) => current.includes(index) ? current.filter((value) => value !== index) : [...current, index])} />
              <input ref={(element) => setInputRef(option.id, element)} aria-label={`Варіант ${index + 1}`} maxLength={LIMITS.optionText.max} value={option.value} onChange={(event) => setOptions((current) => current.map((value, i) => i === index ? { ...value, value: event.target.value } : value))} placeholder={`Варіант ${index + 1}`} />
              <button type="button" aria-label={`Видалити варіант ${index + 1}`} disabled={options.length <= bounds.min} onClick={() => { focusNeighbor(options, index); setOptions((current) => current.filter((_, i) => i !== index)); setCorrectIndexes((current) => current.filter((i) => i !== index).map((i) => i > index ? i - 1 : i)); if (correctIndex === index) setCorrectIndex(null); else if (correctIndex !== null && correctIndex > index) setCorrectIndex((i) => i === null ? null : i - 1); }}>×</button>
            </div>)}
            <button className="editor-secondary" type="button" disabled={options.length >= bounds.max} onClick={() => setOptions((current) => [...current, { id: makeId(), value: "" }])}>＋ Додати варіант</button>
          </fieldset>}
          {type === "ordering" && <fieldset className="question-fieldset"><legend>ЕЛЕМЕНТИ У ПРАВИЛЬНОМУ ПОРЯДКУ</legend>
            {items.map((item, index) => <div className="editor-list-row" key={item.id}><span className="editor-order-number">{index + 1}</span><input ref={(element) => setInputRef(item.id, element)} aria-label={`Елемент ${index + 1}`} maxLength={LIMITS.optionText.max} value={item.value} onChange={(event) => setItems((current) => current.map((value, i) => i === index ? { ...value, value: event.target.value } : value))} placeholder={`Елемент ${index + 1}`} /><button type="button" aria-label={`Перемістити елемент ${index + 1} вище`} disabled={index === 0} onClick={() => { focusAfterChange(item.id); setItems((current) => moveItem(current, index, -1)); }}>↑</button><button type="button" aria-label={`Перемістити елемент ${index + 1} нижче`} disabled={index === items.length - 1} onClick={() => { focusAfterChange(item.id); setItems((current) => moveItem(current, index, 1)); }}>↓</button><button type="button" aria-label={`Видалити елемент ${index + 1}`} disabled={items.length <= bounds.min} onClick={() => { focusNeighbor(items, index); setItems((current) => current.filter((_, i) => i !== index)); }}>×</button></div>)}
            <button className="editor-secondary" type="button" disabled={items.length >= bounds.max} onClick={() => setItems((current) => [...current, { id: makeId(), value: "" }])}>＋ Додати елемент</button>
          </fieldset>}
          {type === "matching" && <fieldset className="question-fieldset"><legend>ПАРИ ДЛЯ З’ЄДНАННЯ</legend>
            {pairs.map((pair, index) => <div className="editor-pair-row" key={pair.id}><label><span>Ліва частина, пара {index + 1}</span><input ref={(element) => setInputRef(`${pair.id}-left`, element)} maxLength={LIMITS.optionText.max} value={pair.left} onChange={(event) => setPairs((current) => current.map((value, i) => i === index ? { ...value, left: event.target.value } : value))} /></label><span aria-hidden="true">↔</span><label><span>Права частина, пара {index + 1}</span><input ref={(element) => setInputRef(`${pair.id}-right`, element)} maxLength={LIMITS.optionText.max} value={pair.right} onChange={(event) => setPairs((current) => current.map((value, i) => i === index ? { ...value, right: event.target.value } : value))} /></label><button type="button" aria-label={`Видалити пару ${index + 1}`} disabled={pairs.length <= LIMITS.matchingPairs.min} onClick={() => { focusAfterChange(pairs[index + 1]?.id ? `${pairs[index + 1].id}-left` : pairs[index - 1]?.id ? `${pairs[index - 1].id}-left` : undefined); setPairs((current) => current.filter((_, i) => i !== index)); }}>×</button></div>)}
            <button className="editor-secondary" type="button" disabled={pairs.length >= LIMITS.matchingPairs.max} onClick={() => setPairs((current) => [...current, { id: makeId(), left: "", right: "" }])}>＋ Додати пару</button>
          </fieldset>}
          {type === "numeric" && <fieldset className="question-fieldset question-meta-fields"><legend>ПРАВИЛЬНА ВІДПОВІДЬ</legend><label className="field-label">ЧИСЛО<input type="number" step="any" value={numericValue} onChange={(event) => setNumericValue(event.target.value)} /></label><label className="field-label">ДОПУСК — НЕОБОВ’ЯЗКОВО<input type="number" min="0" step="any" value={tolerance} onChange={(event) => setTolerance(event.target.value)} /></label></fieldset>}
          {type === "short_answer" && <fieldset className="question-fieldset"><legend>ДОПУСТИМІ ВІДПОВІДІ</legend>{accepted.map((answer, index) => <div className="editor-list-row" key={answer.id}><input ref={(element) => setInputRef(answer.id, element)} aria-label={`Допустима відповідь ${index + 1}`} maxLength={LIMITS.shortAnswerLength.max} value={answer.value} onChange={(event) => setAccepted((current) => current.map((value, i) => i === index ? { ...value, value: event.target.value } : value))} placeholder={`Відповідь ${index + 1}`} /><button type="button" aria-label={`Видалити відповідь ${index + 1}`} disabled={accepted.length <= LIMITS.shortAnswerAccepted.min} onClick={() => { focusNeighbor(accepted, index); setAccepted((current) => current.filter((_, i) => i !== index)); }}>×</button></div>)}<button className="editor-secondary" type="button" disabled={accepted.length >= LIMITS.shortAnswerAccepted.max} onClick={() => setAccepted((current) => [...current, { id: makeId(), value: "" }])}>＋ Додати відповідь</button><label className="question-check"><input type="checkbox" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.target.checked)} /> Розрізняти великі й малі літери</label></fieldset>}
          {errors.length > 0 && <ul className="question-errors" role="alert">{errors.map((error) => <li key={error}>{error}</li>)}</ul>}
          {notice && <p className="question-notice" role="status">{notice}</p>}
          <button className="primary-button" type="submit" disabled={saving}>{editingId ? "Зберегти зміни" : "Додати запитання до чернетки"}</button>
          {editingId && <button className="editor-secondary" type="button" data-dirty-ignore disabled={saving} onClick={resetForm}>Скасувати редагування</button>}
        </form>}
        <aside className="question-preview-panel"><h3>Питання в тесті ({questions.length})</h3>{!loading && questions.length === 0 && <p className="question-preview-help">Питань поки немає.</p>}{questions.map((question, index) => <div className="saved-question-row" key={question.id}>{preview(question, `saved-preview-${question.id}`)}{(!supabase || (selectedDraft && draftStatus === "draft")) && <div className="saved-question-actions"><button type="button" disabled={saving || index === 0} onClick={() => void moveQuestion(question, -1)} aria-label={`Перемістити питання ${index + 1} вище`}>↑</button><button type="button" disabled={saving || index === questions.length - 1} onClick={() => void moveQuestion(question, 1)} aria-label={`Перемістити питання ${index + 1} нижче`}>↓</button><button type="button" disabled={saving} onClick={() => loadQuestion(question)}>Редагувати</button><button type="button" className="danger" disabled={saving} onClick={() => void deleteQuestion(question)}>Видалити</button></div>}</div>)}</aside>
      </div>
    </section>
  );
}


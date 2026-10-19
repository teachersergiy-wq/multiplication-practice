import { useState, type FormEvent } from "react";
import type { AuthoredQuestion, QuestionType } from "../../contracts/api";
import { LIMITS } from "../../contracts/api";
import { questionTypeLabels } from "../domain";
import { isAuthoredQuestion, validateAuthoredQuestion } from "../question-validation";

const questionTypes: QuestionType[] = ["true_false", "single_choice", "multiple_choice", "ordering", "matching", "numeric", "short_answer"];
const initialOptions = ["", "", "", ""];
const moveItem = <T,>(items: T[], index: number, direction: -1 | 1): T[] => {
  const target = index + direction;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
};

export function QuestionEditor() {
  const [type, setType] = useState<QuestionType>("numeric");
  const [promptText, setPromptText] = useState("");
  const [points, setPoints] = useState("1");
  const [timeLimit, setTimeLimit] = useState("");
  const [options, setOptions] = useState<string[]>(initialOptions);
  const [correctIndex, setCorrectIndex] = useState<number | null>(null);
  const [correctIndexes, setCorrectIndexes] = useState<number[]>([]);
  const [items, setItems] = useState<string[]>(["", "", ""]);
  const [pairs, setPairs] = useState<{ left: string; right: string }[]>([{ left: "", right: "" }, { left: "", right: "" }]);
  const [correctBoolean, setCorrectBoolean] = useState<boolean | null>(null);
  const [numericValue, setNumericValue] = useState("");
  const [tolerance, setTolerance] = useState("");
  const [accepted, setAccepted] = useState<string[]>([""]);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [questions, setQuestions] = useState<AuthoredQuestion[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState("");

  function changeType(next: QuestionType) {
    setType(next); setErrors([]); setNotice("");
    if (next === "single_choice") { setOptions(["", "", "", ""]); setCorrectIndexes([]); setCorrectIndex(null); }
    if (next === "multiple_choice") { setOptions(["", "", ""]); setCorrectIndexes([]); }
    if (next === "ordering") setItems(["", "", ""]);
    if (next === "matching") setPairs([{ left: "", right: "" }, { left: "", right: "" }]);
    if (next === "short_answer") setAccepted([""]);
  }

  function makeQuestion(): unknown {
    const common = { promptText, points: Number(points), ...(timeLimit ? { timeLimitSeconds: Number(timeLimit) } : {}) };
    switch (type) {
      case "true_false": return { ...common, type, correct: correctBoolean };
      case "single_choice": return { ...common, type, options, correctIndex };
      case "multiple_choice": return { ...common, type, options, correctIndexes };
      case "ordering": return { ...common, type, itemsInCorrectOrder: items };
      case "matching": return { ...common, type, pairs };
      case "numeric": return { ...common, type, value: numericValue.trim() ? Number(numericValue) : Number.NaN, ...(tolerance ? { tolerance: Number(tolerance) } : {}) };
      case "short_answer": return { ...common, type, accepted, caseSensitive };
    }
  }

  function saveQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const candidate = makeQuestion();
    const validationErrors = validateAuthoredQuestion(candidate);
    setErrors(validationErrors); setNotice("");
    if (!isAuthoredQuestion(candidate)) return;
    setQuestions((current) => [...current, candidate]);
    setNotice("Запитання додано до цієї сесії. Воно ще не надіслане на сервер.");
    setPromptText("");
  }

  function preview(question: AuthoredQuestion) {
    return <article className="question-preview" key={`${question.type}-${question.promptText}-${questions.indexOf(question)}`}>
      <span className="question-preview-type">{questionTypeLabels[question.type]} · {question.points} б.</span>
      <strong>{question.promptText}</strong>
      {question.type === "true_false" && <p>Так &nbsp; / &nbsp; Ні</p>}
      {(question.type === "single_choice" || question.type === "multiple_choice") && <ol>{question.options.map((option, index) => <li key={index}>{option}</li>)}</ol>}
      {question.type === "ordering" && <ol>{[...question.itemsInCorrectOrder].reverse().map((item, index) => <li key={index}>{item}</li>)}</ol>}
      {question.type === "matching" && <div className="preview-match-columns"><ul>{question.pairs.map((pair, index) => <li key={`left-${index}`}>{pair.left}</li>)}</ul><ul>{[...question.pairs].reverse().map((pair, index) => <li key={`right-${index}`}>{pair.right}</li>)}</ul></div>}
      {(question.type === "numeric" || question.type === "short_answer") && <p className="preview-response">Поле для відповіді учня</p>}
    </article>;
  }

  const bounds = type === "single_choice" ? LIMITS.singleChoiceOptions : type === "multiple_choice" ? LIMITS.multipleChoiceOptions : LIMITS.orderingItems;
  return (
    <section className="question-editor" id="question-editor">
      <div className="section-heading"><div><div className="eyebrow muted">КОНСТРУКТОР</div><h2>Редактор запитань</h2></div><span className="section-aside">Зараз — локальна чернетка</span></div>
      <div className="question-editor-grid">
        <form className="question-form" onSubmit={saveQuestion}>
          <label className="field-label">ТИП ЗАПИТАННЯ
            <select value={type} onChange={(event) => changeType(event.target.value as QuestionType)}>
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
          </div>
          {type === "true_false" && <fieldset className="question-fieldset"><legend>ПРАВИЛЬНА ВІДПОВІДЬ</legend>{([true, false] as const).map((value) => <label key={String(value)}><input type="radio" name="boolean-answer" checked={correctBoolean === value} onChange={() => setCorrectBoolean(value)} />{value ? "Так" : "Ні"}</label>)}</fieldset>}
          {(type === "single_choice" || type === "multiple_choice") && <fieldset className="question-fieldset"><legend>ВАРІАНТИ ТА ПРАВИЛЬНА ВІДПОВІДЬ</legend>
            {options.map((option, index) => <div className="editor-list-row" key={index}>
              <input type={type === "single_choice" ? "radio" : "checkbox"} name="choice-answer" aria-label={`Позначити варіант ${index + 1} правильним`} checked={type === "single_choice" ? correctIndex === index : correctIndexes.includes(index)} onChange={() => type === "single_choice" ? setCorrectIndex(index) : setCorrectIndexes((current) => current.includes(index) ? current.filter((value) => value !== index) : [...current, index])} />
              <input aria-label={`Варіант ${index + 1}`} maxLength={LIMITS.optionText.max} value={option} onChange={(event) => setOptions((current) => current.map((value, i) => i === index ? event.target.value : value))} placeholder={`Варіант ${index + 1}`} />
              <button type="button" aria-label={`Видалити варіант ${index + 1}`} disabled={options.length <= bounds.min} onClick={() => { setOptions((current) => current.filter((_, i) => i !== index)); setCorrectIndexes((current) => current.filter((i) => i !== index).map((i) => i > index ? i - 1 : i)); if (correctIndex === index) setCorrectIndex(null); else if (correctIndex !== null && correctIndex > index) setCorrectIndex((i) => i === null ? null : i - 1); }}>×</button>
            </div>)}
            <button className="editor-secondary" type="button" disabled={options.length >= bounds.max} onClick={() => setOptions((current) => [...current, ""])}>＋ Додати варіант</button>
          </fieldset>}
          {type === "ordering" && <fieldset className="question-fieldset"><legend>ЕЛЕМЕНТИ У ПРАВИЛЬНОМУ ПОРЯДКУ</legend>
            {items.map((item, index) => <div className="editor-list-row" key={index}><span className="editor-order-number">{index + 1}</span><input aria-label={`Елемент ${index + 1}`} maxLength={LIMITS.optionText.max} value={item} onChange={(event) => setItems((current) => current.map((value, i) => i === index ? event.target.value : value))} placeholder={`Елемент ${index + 1}`} /><button type="button" aria-label={`Перемістити елемент ${index + 1} вище`} disabled={index === 0} onClick={() => setItems((current) => moveItem(current, index, -1))}>↑</button><button type="button" aria-label={`Перемістити елемент ${index + 1} нижче`} disabled={index === items.length - 1} onClick={() => setItems((current) => moveItem(current, index, 1))}>↓</button><button type="button" aria-label={`Видалити елемент ${index + 1}`} disabled={items.length <= bounds.min} onClick={() => setItems((current) => current.filter((_, i) => i !== index))}>×</button></div>)}
            <button className="editor-secondary" type="button" disabled={items.length >= bounds.max} onClick={() => setItems((current) => [...current, ""])}>＋ Додати елемент</button>
          </fieldset>}
          {type === "matching" && <fieldset className="question-fieldset"><legend>ПАРИ ДЛЯ З’ЄДНАННЯ</legend>
            {pairs.map((pair, index) => <div className="editor-pair-row" key={index}><label><span>Ліва частина, пара {index + 1}</span><input maxLength={LIMITS.optionText.max} value={pair.left} onChange={(event) => setPairs((current) => current.map((value, i) => i === index ? { ...value, left: event.target.value } : value))} /></label><span aria-hidden="true">↔</span><label><span>Права частина, пара {index + 1}</span><input maxLength={LIMITS.optionText.max} value={pair.right} onChange={(event) => setPairs((current) => current.map((value, i) => i === index ? { ...value, right: event.target.value } : value))} /></label><button type="button" aria-label={`Видалити пару ${index + 1}`} disabled={pairs.length <= LIMITS.matchingPairs.min} onClick={() => setPairs((current) => current.filter((_, i) => i !== index))}>×</button></div>)}
            <button className="editor-secondary" type="button" disabled={pairs.length >= LIMITS.matchingPairs.max} onClick={() => setPairs((current) => [...current, { left: "", right: "" }])}>＋ Додати пару</button>
          </fieldset>}
          {type === "numeric" && <fieldset className="question-fieldset question-meta-fields"><legend>ПРАВИЛЬНА ВІДПОВІДЬ</legend><label className="field-label">ЧИСЛО<input type="number" step="any" value={numericValue} onChange={(event) => setNumericValue(event.target.value)} /></label><label className="field-label">ДОПУСК — НЕОБОВ’ЯЗКОВО<input type="number" min="0" step="any" value={tolerance} onChange={(event) => setTolerance(event.target.value)} /></label></fieldset>}
          {type === "short_answer" && <fieldset className="question-fieldset"><legend>ДОПУСТИМІ ВІДПОВІДІ</legend>{accepted.map((answer, index) => <div className="editor-list-row" key={index}><input aria-label={`Допустима відповідь ${index + 1}`} maxLength={LIMITS.shortAnswerLength.max} value={answer} onChange={(event) => setAccepted((current) => current.map((value, i) => i === index ? event.target.value : value))} placeholder={`Відповідь ${index + 1}`} /><button type="button" aria-label={`Видалити відповідь ${index + 1}`} disabled={accepted.length <= LIMITS.shortAnswerAccepted.min} onClick={() => setAccepted((current) => current.filter((_, i) => i !== index))}>×</button></div>)}<button className="editor-secondary" type="button" disabled={accepted.length >= LIMITS.shortAnswerAccepted.max} onClick={() => setAccepted((current) => [...current, ""])}>＋ Додати відповідь</button><label className="question-check"><input type="checkbox" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.target.checked)} /> Розрізняти великі й малі літери</label></fieldset>}
          {errors.length > 0 && <ul className="question-errors" role="alert">{errors.map((error) => <li key={error}>{error}</li>)}</ul>}
          {notice && <p className="question-notice" role="status">{notice}</p>}
          <button className="primary-button" type="submit">Додати запитання до чернетки</button>
        </form>
        <aside className="question-preview-panel"><h3>Попередній перегляд</h3><p className="question-preview-help">Правильні відповіді тут не позначаються.</p>{preview(makeQuestion() as AuthoredQuestion)}<h3>Питання в цій сесії ({questions.length})</h3>{questions.map((question) => preview(question))}</aside>
      </div>
    </section>
  );
}
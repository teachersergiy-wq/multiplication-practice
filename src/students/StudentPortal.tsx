import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AnswerResponse, FinishAttemptData, PublicQuestion, StartAttemptData } from "../../contracts/api";
import { useStudentIdentity } from "../auth/TeacherAccessGate";
import { invokeFunction } from "../lib/function-api";
import { supabase } from "../lib/supabase";
import { formatScore, partialCreditHint, practiceFeedbackText } from "../scoring.js";
import { assignmentWindow, attemptStorage, clearAllAttemptDrafts, clearAttemptDraft, publicFeedback, readAttemptDraft, remainingSeconds, responseForQuestion, studentApiMessage, writeAttemptDraft } from "./student-flow.js";

type AssignmentRow = {
  id: string; class_id: string; template_id: string; opens_at: string | null; closes_at: string | null;
  allow_retries: boolean; created_at: string;
  template: { title: string; mode: "practice" | "graded"; grade_level: number };
};
type AttemptRow = {
  id: string; assignment_id: string; status: string; started_at: string; finished_at: string | null;
  score: number | null; max_score: number | null; passed: boolean | null; elapsed_ms: number | null;
};
type AttemptState = { data: StartAttemptData; receivedAt: number };
type PortalTab = "assignments" | "history";

const db = (client: SupabaseClient) => client as any;

export function StudentPortal({ client = supabase }: { client?: SupabaseClient | null }) {
  const student = useStudentIdentity();
  const [className, setClassName] = useState("");
  const [assignments, setAssignments] = useState<AssignmentRow[]>([]);
  const [attempts, setAttempts] = useState<AttemptRow[]>([]);
  const [tab, setTab] = useState<PortalTab>("assignments");
  const [attempt, setAttempt] = useState<AttemptState | null>(null);
  const [result, setResult] = useState<FinishAttemptData | null>(null);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [feedback, setFeedback] = useState<{ isCorrect: boolean; awardedPoints: number } | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [activeAssignmentId, setActiveAssignmentId] = useState("");
  const finishStarted = useRef(false);
  const expiredHandled = useRef(false);

  const refresh = useCallback(async () => {
    if (!client || !student) return;
    const clientDb = db(client);
    const [membership, history] = await Promise.all([
      clientDb.from("class_students").select("class_id,class:classes(name)").eq("student_id", student.userId).maybeSingle(),
      clientDb.from("assessment_attempts").select("id,assignment_id,status,started_at,finished_at,score,max_score,passed,elapsed_ms").eq("student_id", student.userId).order("started_at", { ascending: false }),
    ]);
    if (history.error) setMessage("Не вдалося завантажити історію спроб. Перевірте з’єднання й повторіть.");
    else setAttempts((history.data ?? []) as AttemptRow[]);
    if (membership.error) {
      setMessage("Не вдалося завантажити ваш клас. Перевірте з’єднання й повторіть.");
      return;
    }
    const membershipRow = membership.data as { class_id: string; class?: { name?: string } | null } | null;
    if (!membershipRow) {
      setClassName("");
      setAssignments([]);
      return;
    }
    setClassName(membershipRow.class?.name ?? "Мій клас");
    const assigned = await clientDb.from("assessment_assignments")
      .select("id,class_id,template_id,opens_at,closes_at,allow_retries,created_at,template:assessment_templates!inner(title,mode,grade_level)")
      .eq("class_id", membershipRow.class_id).order("created_at", { ascending: false });
    if (assigned.error) {
      setMessage("Не вдалося завантажити завдання. Перевірте з’єднання й повторіть.");
      return;
    }
    setAssignments((assigned.data ?? []) as AssignmentRow[]);
  }, [client, student]);

  useEffect(() => { void refresh(); }, [refresh, refreshVersion]);

  const attemptByAssignment = useMemo(() => {
    const map = new Map<string, AttemptRow[]>();
    for (const item of attempts) map.set(item.assignment_id, [...(map.get(item.assignment_id) ?? []), item]);
    return map;
  }, [attempts]);

  async function start(assignment: AssignmentRow) {
    if (!client) return;
    setBusy(true); setMessage(""); setResult(null); setFeedback(null);
    const response = await invokeFunction(client, "start-attempt", { assignmentId: assignment.id });
    setBusy(false);
    if (!response.ok) {
      setMessage(studentApiMessage(response.error.code));
      return;
    }
    enterAttempt(response.data, response.data.questions);
  }

  function enterAttempt(data: StartAttemptData, questions: PublicQuestion[]) {
    const receivedAt = Date.now();
    setAttempt({ data: { ...data, questions }, receivedAt });
    finishStarted.current = false;
    expiredHandled.current = false;
    setAnswers(readAttemptDraft(attemptStorage(), data.attemptId));
    const firstUnanswered = questions.findIndex((question) => !data.answeredQuestionIds.includes(question.id));
    setQuestionIndex(firstUnanswered < 0 ? Math.max(0, questions.length - 1) : firstUnanswered);
    setMessage(data.resumed ? "Спробу відновлено. Ваші відповіді збережені." : "Спробу розпочато.");
  }

  const syncAttempt = useCallback(async () => {
    if (!attempt || !client || !activeAssignmentId) return;
    const response = await invokeFunction(client, "start-attempt", { assignmentId: activeAssignmentId });
    if (!response.ok) return;
    if (response.data.attemptId === attempt.data.attemptId) {
      setAttempt({ data: response.data, receivedAt: Date.now() });
    }
  }, [activeAssignmentId, attempt, client]);

  async function startAssignment(assignment: AssignmentRow) {
    setActiveAssignmentId(assignment.id);
    await start(assignment);
  }

  useEffect(() => {
    if (!attempt || !attempt.data.deadlineAt) { setRemaining(null); return; }
    const update = () => {
      const seconds = remainingSeconds(attempt.data.deadlineAt, attempt.data.serverNow, attempt.receivedAt, Date.now());
      setRemaining(seconds);
      if (seconds === 0 && !expiredHandled.current) {
        expiredHandled.current = true;
        setMessage("Час завершився. Зберігаємо результат…");
        void finish(attempt.data.attemptId);
      }
    };
    update();
    const timer = window.setInterval(update, 1000);
    const onVisible = () => { if (document.visibilityState === "visible") void syncAttempt(); };
    const onOnline = () => void syncAttempt();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("online", onOnline); };
  }, [attempt, syncAttempt]);

  const currentQuestion = attempt?.data.questions[questionIndex];
  const currentValue = currentQuestion ? answers[currentQuestion.id] : undefined;
  const displayIndex = currentQuestion ? currentQuestion.position : 0;

  function updateAnswer(question: PublicQuestion, value: unknown) {
    setAnswers((current) => ({ ...current, [question.id]: value }));
    if (attempt && !writeAttemptDraft(attemptStorage(), attempt.data.attemptId, question.id, responseForQuestion(question, value) ?? value)) {
      setMessage("Відповідь поки збережена на екрані. Перевірте місце в пам’яті пристрою, щоб не втратити її при оновленні сторінки.");
    }
  }

  async function submitCurrent() {
    if (!client || !attempt || !currentQuestion || busy) return;
    const response = responseForQuestion(currentQuestion, answers[currentQuestion.id]);
    if (!response) { setMessage("Дайте відповідь, щоб продовжити."); return; }
    setBusy(true); setMessage(""); setFeedback(null);
    const submitted = await invokeFunction(client, "submit-answer", { attemptId: attempt.data.attemptId, questionId: currentQuestion.id, response: response as AnswerResponse });
    setBusy(false);
    if (!submitted.ok) {
      if (submitted.error.code === "attempt_expired") {
        setMessage(studentApiMessage(submitted.error.code));
        await finish(attempt.data.attemptId);
      } else if (submitted.error.code === "already_answered") {
        clearAttemptDraft(attemptStorage(), attempt.data.attemptId, currentQuestion.id);
        setAttempt((value) => value ? { ...value, data: { ...value.data, answeredQuestionIds: [...new Set([...value.data.answeredQuestionIds, currentQuestion.id])] } } : value);
        setMessage(studentApiMessage(submitted.error.code));
        goNext(currentQuestion.id);
      } else setMessage(studentApiMessage(submitted.error.code));
      return;
    }
    clearAttemptDraft(attemptStorage(), attempt.data.attemptId, currentQuestion.id);
    const practiceFeedback = publicFeedback(attempt.data.mode, submitted);
    setFeedback(practiceFeedback);
    setAttempt((value) => value ? { ...value, data: { ...value.data, answeredQuestionIds: [...new Set([...value.data.answeredQuestionIds, currentQuestion.id])] } } : value);
    setMessage("Відповідь збережено.");
  }

  function goNext(questionId: string) {
    if (!attempt) return;
    const answered = new Set(attempt.data.answeredQuestionIds);
    answered.add(questionId);
    const nextIndex = attempt.data.questions.findIndex((question) => !answered.has(question.id));
    if (nextIndex >= 0) setQuestionIndex(nextIndex);
    else setQuestionIndex(Math.min(questionIndex + 1, attempt.data.questions.length - 1));
    setFeedback(null);
  }

  async function finish(attemptId = attempt?.data.attemptId) {
    if (!client || !attemptId || busy) return;
    if (finishStarted.current) return;
    finishStarted.current = true;
    setBusy(true);
    const response = await invokeFunction(client, "finish-attempt", { attemptId });
    setBusy(false);
    if (!response.ok) { finishStarted.current = false; setMessage(studentApiMessage(response.error.code)); return; }
    let finishedResult = response.data;
    if (!Number.isFinite(finishedResult.mistakes) || !Number.isFinite(finishedResult.questionCount) || !Number.isFinite(finishedResult.answeredCount)) {
      const stored = await db(client).from("assessment_responses").select("is_correct").eq("attempt_id", attemptId);
      if (!stored.error && Array.isArray(stored.data) && attempt?.data.attemptId === attemptId) {
        const total = attempt.data.questions.length;
        const correct = stored.data.filter((row: { is_correct: boolean | null }) => row.is_correct === true).length;
        finishedResult = { ...finishedResult, questionCount: total, answeredCount: stored.data.length, mistakes: Math.max(0, total - correct) };
      }
    }
    setResult(finishedResult);
    setAttempt(null);
    setFeedback(null);
    clearAllAttemptDrafts(attemptStorage());
    setMessage("");
    setRefreshVersion((version) => version + 1);
  }

  if (!student) return <main className="student-shell"><p>Перевіряємо обліковий запис…</p></main>;
  if (result) return <StudentResult result={result} onBack={() => { setResult(null); setTab("history"); }} />;
  if (attempt && currentQuestion) return <AttemptScreen
    question={currentQuestion} index={displayIndex} total={attempt.data.questions.length} mode={attempt.data.mode}
    value={currentValue} feedback={feedback} remaining={remaining} busy={busy} message={message}
    onChange={(value) => updateAnswer(currentQuestion, value)} onSubmit={submitCurrent}
    onContinue={() => currentQuestion.id && goNext(currentQuestion.id)}
    onFinish={() => void finish()} allAnswered={attempt.data.questions.every((question) => attempt.data.answeredQuestionIds.includes(question.id))} answeredIds={attempt.data.answeredQuestionIds}
    resumed={attempt.data.resumed} />;

  const now = Date.now();
  return <main className="student-shell">
    <header className="student-topbar"><a className="brand" href="#home"><span className="brand-mark">н</span><span>навчальна<span className="brand-light">студія</span></span></a><button className="student-profile" onClick={() => void student.signOut()} aria-label="Вийти">{student.displayName} <span aria-hidden="true">↪</span></button></header>
    <section className="student-content">
      <p className="student-kicker">{className || "КАБІНЕТ УЧНЯ"}</p><h1>Привіт, {student.displayName.split(/\s+/)[0]}!</h1>
      <div className="student-tabs" role="tablist" aria-label="Розділи учня"><button role="tab" aria-selected={tab === "assignments"} onClick={() => setTab("assignments")}>Завдання</button><button role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")}>Мої спроби</button></div>
      {message && <p className="student-notice" role="status">{message}<button onClick={() => setMessage("")} aria-label="Закрити повідомлення">×</button></p>}
      {tab === "assignments" ? <section className="student-list" aria-label="Завдання класу">
        <h2>Завдання класу</h2>
        {!assignments.length ? <div className="student-empty">Поки немає призначених тестів. Зазирни сюди трохи пізніше.</div> : assignments.map((assignment) => {
          const windowState = assignmentWindow(assignment.opens_at, assignment.closes_at, now);
          const previous = attemptByAssignment.get(assignment.id) ?? [];
          const inProgress = previous.find((item) => item.status === "in_progress");
          const completed = previous.some((item) => item.status !== "in_progress");
          const disabled = busy || (!inProgress && completed && !assignment.allow_retries);
          const action = inProgress ? "Продовжити" : completed && !assignment.allow_retries ? "Спроба завершена" : windowState === "open" ? "Почати" : "Перевірити доступність";
          return <article className="student-assignment" key={assignment.id}>
            <div><span className="student-assignment-mode">{assignment.template.mode === "practice" ? "Тренування" : "Перевірка знань"} · {assignment.template.grade_level} клас</span><h3>{assignment.template.title}</h3><p>{availabilityLabel(windowState, assignment.opens_at, assignment.closes_at)}</p></div>
            <button className="student-button" disabled={disabled} onClick={() => void startAssignment(assignment)}>{busy ? "Зачекай…" : action}</button>
          </article>;
        })}
      </section> : <section className="student-list" aria-label="Історія спроб"><h2>Мої спроби</h2>{!attempts.length ? <div className="student-empty">Тут з’являться завершені спроби.</div> : attempts.map((item) => {
        const assignment = assignments.find((row) => row.id === item.assignment_id);
        const percent = item.score !== null && Number(item.max_score) > 0 ? Number(item.score) / Number(item.max_score) * 100 : null;
        return <article className="student-history-row" key={item.id}><div><strong>{assignment?.template.title ?? "Тест"}</strong><small>{new Date(item.started_at).toLocaleString("uk-UA", { dateStyle: "medium", timeStyle: "short" })}</small></div><span>{item.status === "completed" ? percent === null ? "Завершено" : `${formatScore(percent)}% · ${formatScore(item.score)}/${formatScore(item.max_score)}` : item.status === "abandoned" ? "Час завершився" : "У процесі"}</span></article>;
      })}</section>}
    </section>
  </main>;
}

function availabilityLabel(state: "open" | "upcoming" | "closed", opensAt: string | null, closesAt: string | null) {
  if (state === "upcoming") return `Відкриється ${new Date(opensAt!).toLocaleString("uk-UA", { dateStyle: "medium", timeStyle: "short" })}`;
  if (state === "closed") return "Час виконання завершився";
  return closesAt ? `Виконати до ${new Date(closesAt).toLocaleString("uk-UA", { dateStyle: "medium", timeStyle: "short" })}` : "Доступне зараз";
}

function AttemptScreen(props: {
  question: PublicQuestion; index: number; total: number; mode: "practice" | "graded"; value: unknown;
  feedback: { isCorrect: boolean; awardedPoints: number } | null; remaining: number | null; busy: boolean; message: string;
  resumed: boolean; allAnswered: boolean; answeredIds: string[]; onChange: (value: unknown) => void; onSubmit: () => void; onContinue: () => void; onFinish: () => void;
}) {
  const { question, index, total, mode, value, feedback, remaining, busy, message, allAnswered, answeredIds, onChange, onSubmit, onContinue, onFinish } = props;
  const complete = answeredIds.includes(question.id);
  return <main className="student-shell student-test-shell">
    <header className="student-test-header"><a className="brand" href="#home" aria-label="Навчальна студія"><span className="brand-mark">н</span><span>навчальна<span className="brand-light">студія</span></span></a>{remaining !== null && <span className="student-timer" aria-live="off">Залишилось {formatTime(remaining)}</span>}</header>
    <section className="student-question-area"><div className="student-progress"><span>Запитання {index} з {total}</span><div role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={index}><i style={{ width: `${Math.min(100, index / total * 100)}%` }} /></div></div>
      <article className="student-question-card"><p className="student-question-prompt">{question.promptText}</p>{partialCreditHint(question.type) && <p className="partial-credit-hint">{partialCreditHint(question.type)}</p>}<AnswerControl question={question} value={value} disabled={busy || complete} onChange={onChange} />
        {feedback && mode === "practice" && <p className={`student-feedback ${feedback.isCorrect ? "is-correct" : feedback.awardedPoints > 0 ? "is-partial" : "is-incorrect"}`} role="status">{practiceFeedbackText(feedback, question.points)}</p>}
      </article>
    </section>
    <footer className="student-action-bar">{message && <p role="status">{message}</p>}{complete ? <div className="student-action-buttons"><button className="student-button secondary" disabled={busy} onClick={onContinue}>Далі</button><button className="student-button" disabled={busy} onClick={onFinish}>{busy ? "Зберігаємо…" : allAnswered ? "Завершити тест" : "Завершити раніше"}</button></div> : <button className="student-button" disabled={busy || !responseForQuestion(question, value)} onClick={onSubmit}>{busy ? "Зберігаємо відповідь…" : "Зберегти й далі"}</button>}</footer>
  </main>;
}

function AnswerControl({ question, value, disabled, onChange }: { question: PublicQuestion; value: unknown; disabled: boolean; onChange: (value: unknown) => void }) {
  if (question.type === "true_false") return <div className="student-options">{[[true, "Так"], [false, "Ні"]].map(([answer, label]) => <button key={String(answer)} className={`student-option ${value === answer ? "selected" : ""}`} aria-pressed={value === answer} disabled={disabled} onClick={() => onChange(answer)}>{label}</button>)}</div>;
  if (question.type === "single_choice" || question.type === "multiple_choice") {
    const selected = Array.isArray(value) ? value as string[] : typeof value === "string" ? [value] : [];
    return <div className="student-options">{question.choices.map((choice) => {
      const active = selected.includes(choice.id);
      return <button key={choice.id} className={`student-option ${active ? "selected" : ""}`} aria-pressed={active} disabled={disabled} onClick={() => onChange(question.type === "single_choice" ? choice.id : active ? selected.filter((id) => id !== choice.id) : [...selected, choice.id])}><span className="student-option-mark">{active ? "✓" : ""}</span>{choice.text}</button>;
    })}</div>;
  }
  if (question.type === "ordering") {
    const initial = question.choices.map((choice) => choice.id);
    const order = Array.isArray(value) ? value as string[] : initial;
    const move = (from: number, by: number) => { const to = from + by; if (to < 0 || to >= order.length) return; const next = [...order]; [next[from], next[to]] = [next[to], next[from]]; onChange(next); };
    return <ol className="student-order-list">{order.map((id, index) => <li key={id}><span>{question.choices.find((choice) => choice.id === id)?.text}</span><div><button aria-label={`Перемістити на позицію ${index}`} disabled={disabled || index === 0} onClick={() => move(index, -1)}>↑</button><button aria-label={`Перемістити на позицію ${index + 2}`} disabled={disabled || index === order.length - 1} onClick={() => move(index, 1)}>↓</button></div></li>)}</ol>;
  }
  if (question.type === "matching") return <MatchingControl question={question} value={value} disabled={disabled} onChange={onChange} />;
  if (question.type === "numeric" || question.type === "short_answer") return <label className="student-answer-label" htmlFor={`answer-${question.id}`}>{question.type === "numeric" ? "Твоя відповідь" : "Напиши відповідь"}<input id={`answer-${question.id}`} type="text" inputMode={question.type === "numeric" ? "decimal" : "text"} autoComplete="off" value={typeof value === "string" ? value : ""} disabled={disabled} onChange={(event) => onChange(event.target.value)} /></label>;
  return null;
}

function MatchingControl({ question, value, disabled, onChange }: { question: Extract<PublicQuestion, { type: "matching" }>; value: unknown; disabled: boolean; onChange: (value: unknown) => void }) {
  const answerState = value && typeof value === "object" && !Array.isArray(value) ? value as { pairs?: { leftId: string; rightId: string }[]; selectedLeft?: string } : null;
  const pairs = Array.isArray(value) ? value as { leftId: string; rightId: string }[] : answerState?.pairs ?? [];
  const selectedLeft = answerState?.selectedLeft ?? "";
  const leftItems = question.items.filter((item) => item.side === "left");
  const rightItems = question.items.filter((item) => item.side === "right");
  return <div className="student-match-grid"><section><h3>Обери елемент</h3>{leftItems.map((item) => <button key={item.id} className={`student-option ${selectedLeft === item.id ? "selected" : ""}`} aria-pressed={selectedLeft === item.id} disabled={disabled} onClick={() => onChange({ pairs, selectedLeft: item.id })}>{item.text}<small>{pairs.some((pair) => pair.leftId === item.id) ? " · пару обрано" : " · обери пару"}</small></button>)}</section><section><h3>Знайди пару</h3>{rightItems.map((item) => <button key={item.id} className={`student-option ${pairs.some((pair) => pair.rightId === item.id) ? "selected" : ""}`} aria-pressed={pairs.some((pair) => pair.rightId === item.id)} disabled={disabled || !selectedLeft} onClick={() => { if (!selectedLeft) return; onChange({ pairs: [...pairs.filter((pair) => pair.leftId !== selectedLeft && pair.rightId !== item.id), { leftId: selectedLeft, rightId: item.id }], selectedLeft: "" }); }}>{item.text}</button>)}</section></div>;
}

function StudentResult({ result, onBack }: { result: FinishAttemptData; onBack: () => void }) {
  return <main className="student-shell"><header className="student-topbar"><a className="brand" href="#home"><span className="brand-mark">н</span><span>навчальна<span className="brand-light">студія</span></span></a></header><section className="student-result-card"><p className="student-kicker">ТЕСТ ЗАВЕРШЕНО</p><h1>Твій результат</h1><div className="student-result-score">{formatScore(result.percent)}<small>%</small></div><p className="student-result-points">{formatScore(result.score)} з {formatScore(result.maxScore)} балів</p>{result.passed !== null && <p className={result.passed ? "student-passed" : "student-not-passed"}>{result.passed ? "Чудова робота — тест складено!" : "Ще трохи практики — і все вийде."}</p>}<p>Правильних відповідей: {result.answeredCount - result.mistakes} із {result.questionCount}</p><p>Помилок: {result.mistakes}</p><button className="student-button" onClick={onBack}>До моїх спроб</button></section></main>;
}

function formatTime(seconds: number) {
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

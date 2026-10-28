import "./competitive.css";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompetitiveQuestion, CompetitiveRunResult, CompetitiveTopic, ResultVisibility, SubmitCompetitiveAnswerData } from "../../contracts/api";
import { invokeFunction } from "../lib/function-api";
import { competitiveApiMessage, competitiveRemainingSeconds, formatCompetitiveDuration, publishChoices, qualifiedLabels, updateQuestionClock } from "./competitive-flow.js";

type ClockState = { serverNow: string; receivedAt: number; limitMs: number };
type LiveRun = { runId: string; topicCode: string; levelNumber: number; isEndless: boolean; questionCount: number | null; answeredCount: number; question: CompetitiveQuestion; score: number; clock: ClockState };
type Outcome = { runId: string; levelNumber: number; isEndless: boolean; result: CompetitiveRunResult; passed: boolean | null };
type AnswerPayload = SubmitCompetitiveAnswerData | { finished: false; correct: boolean; score: number; question: CompetitiveQuestion; limitMs: number };

const VISIBILITY_LABEL: Record<ResultVisibility, string> = { none: "Не публікувати", nickname: "Мій нікнейм", anonymous: "Анонімно", name: "Моє ім’я (лише в рейтингу класу)" };
const LEADERBOARD_SCOPES = ["class", "school", "school_year", "absolute"] as const;
const LEADERBOARD_NAMES = { class: "Клас", school: "Школа", school_year: "Навчальний рік", absolute: "Загальний рейтинг паралелі" } as const;

export function CompetitiveStudent({ client, studentId }: { client: SupabaseClient | null; studentId: string }) {
  const [topics, setTopics] = useState<CompetitiveTopic[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [answerFeedback, setAnswerFeedback] = useState("");
  const [run, setRun] = useState<LiveRun | null>(null);
  const [answer, setAnswer] = useState("");
  const [remaining, setRemaining] = useState(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [visibility, setVisibility] = useState<ResultVisibility>("none");
  const [published, setPublished] = useState(false);
  const [leaderboard, setLeaderboard] = useState<{ topicCode: string; scope: typeof LEADERBOARD_SCOPES[number]; rows: { rank: number; displayName: string; score: number; durationMs: number; achievedAt: string }[] } | null>(null);
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const zeroTimer = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const draftKey = run ? `competitive-answer:${studentId}:${run.runId}:${run.question.id}` : "";

  const loadTopics = useCallback(async () => {
    if (!client) { setLoading(false); setError("Змагання тимчасово недоступні."); return null; }
    setLoading(true);
    const response = await invokeFunction(client, "list-competitive-topics", {});
    setLoading(false);
    if (!response.ok) { setError(competitiveApiMessage(response.error.code)); return null; }
    setTopics(response.data.topics);
    setError("");
    return response.data.topics;
  }, [client]);

  useEffect(() => { void loadTopics(); }, [loadTopics]);
  useEffect(() => {
    if (!run || outcome) return;
    const tick = () => setRemaining(competitiveRemainingSeconds(run.clock.limitMs, run.clock.serverNow, run.clock.receivedAt) ?? 0);
    tick();
    const timer = window.setInterval(tick, 100);
    return () => window.clearInterval(timer);
  }, [run, outcome]);
  useEffect(() => {
    if (!run || outcome || busy || remaining > 0 || zeroTimer.current !== null) return;
    // The server applies a private 1 s network grace; it is deliberately not displayed.
    zeroTimer.current = window.setTimeout(() => {
      zeroTimer.current = null;
      void submit(true);
    }, 1300);
    return () => { if (zeroTimer.current !== null) window.clearTimeout(zeroTimer.current); zeroTimer.current = null; };
  }, [run, outcome, busy, remaining]);
  useEffect(() => {
    if (!run || !inputRef.current || busy) return;
    inputRef.current.focus({ preventScroll: true });
  }, [run?.question.id, busy]);
  useEffect(() => {
    if (!draftKey) return;
    try { setAnswer(sessionStorage.getItem(draftKey) ?? ""); } catch { setAnswer(""); }
  }, [draftKey]);

  async function start(topic: CompetitiveTopic, levelNumber: number) {
    if (!client || busy) return;
    setBusy(true); setError(""); setNotice(""); setAnswerFeedback(""); setAnswer("");
    const response = await invokeFunction(client, "start-competitive-run", { topicCode: topic.code, levelNumber });
    setBusy(false);
    if (!response.ok) {
      if (response.error.code === "not_found") { await loadTopics(); setNotice(competitiveApiMessage("not_found")); }
      else setError(competitiveApiMessage(response.error.code));
      return;
    }
    const level = topic.levels.find((item) => item.levelNumber === levelNumber);
    setRun({ runId: response.data.runId, topicCode: topic.code, levelNumber, isEndless: Boolean(level?.isEndless), questionCount: level?.questionCount ?? null, answeredCount: 0, question: response.data.question, score: 0,
      clock: { serverNow: response.data.serverNow, receivedAt: Date.now(), limitMs: response.data.limitMs } });
  }

  async function submit(timedOut = false) {
    if (!client || !run || busy) return;
    setBusy(true); setError("");
    const value = timedOut && !answer.trim() ? 0 : Number(answer.trim().replace(",", "."));
    const response = await invokeFunction(client, "submit-competitive-answer", {
      runId: run.runId, questionId: run.question.id, response: { type: "numeric", value: Number.isFinite(value) ? value : 0 },
    });
    setBusy(false);
    if (!response.ok) {
      if (response.error.code === "rate_limited") return;
      if (response.error.code === "conflict") {
        setRun(null); setAnswer(""); setNotice("Забіг уже завершився. Онови список тем, щоб побачити доступні рівні."); await loadTopics(); return;
      }
      if (response.error.code === "not_found") { setRun(null); setAnswer(""); setError(competitiveApiMessage("not_found")); await loadTopics(); return; }
      setError(competitiveApiMessage(response.error.code));
      return;
    }
    const data = response.data as AnswerPayload;
    if (data.finished) {
      try { sessionStorage.removeItem(draftKey); } catch { /* storage can be disabled */ }
      setAnswer(""); setRun(null); setVisibility("none"); setPublished(false);
      const result = data.result;
      const refreshedTopics = await loadTopics();
      const updatedTopic = refreshedTopics?.find((topic) => topic.code === run.topicCode);
      const passedLevel = updatedTopic?.levels.find((item) => item.levelNumber === run.levelNumber)?.passed ?? null;
      setOutcome({ runId: result.runId, levelNumber: run.levelNumber, isEndless: run.isEndless, result, passed: passedLevel });
      return;
    }
    const nextClock = updateQuestionClock(run.clock, data.limitMs, Date.now());
    try { sessionStorage.removeItem(draftKey); } catch { /* storage can be disabled */ }
    setAnswer(""); setError("");
    setAnswerFeedback(data.correct ? "Правильно! Наступне запитання." : "Не цього разу — забіг триває.");
    setRun({ ...run, question: data.question, score: data.score, answeredCount: run.answeredCount + 1, clock: nextClock });
  }

  async function publish() {
    if (!client || !outcome || published || busy || visibility === "none") return;
    setBusy(true);
    const response = await invokeFunction(client, "publish-competitive-result", { runId: outcome.runId, visibility });
    setBusy(false);
    if (!response.ok) { setError(competitiveApiMessage(response.error.code)); return; }
    setPublished(true); setNotice(response.data.published ? "Результат опубліковано." : "Результат не публікується.");
  }

  async function openLeaderboard(topicCode: string, scope: typeof LEADERBOARD_SCOPES[number]) {
    if (!client) return;
    setLeaderboardLoading(true); setError("");
    const response = await invokeFunction(client, "get-leaderboard", { topicCode, scope, limit: 10 });
    setLeaderboardLoading(false);
    if (!response.ok) { setError(competitiveApiMessage(response.error.code)); return; }
    setLeaderboard({ topicCode, scope, rows: response.data.rows });
  }

  function leaveRun() { setRun(null); setAnswer(""); setError(""); setNotice(""); void loadTopics(); }

  if (loading && !topics.length && !run && !outcome) return <section className="competitive-panel"><p role="status">Завантажуємо змагання…</p></section>;
  if (run) return <main className="student-shell competitive-run-shell">
    <header className="student-test-header"><button className="competitive-back" onClick={leaveRun}>← Теми</button><span className="competitive-run-score" aria-live="polite">{run.isEndless ? `Серія: ${run.score}` : `Питання ${run.answeredCount + 1} з ${run.questionCount ?? "—"}`}</span><span className="student-timer" aria-live="polite">{remaining > 0 ? `${remaining} с` : "0 с"}</span></header>
    <section className="competitive-question-area" aria-live="polite"><p className="student-kicker">{run.isEndless ? "СУПЕР РІВЕНЬ" : `РІВЕНЬ ${run.levelNumber}`}</p>
      <article className="competitive-question-card"><h1>{run.question.promptText}</h1><label className="competitive-answer-label" htmlFor="competitive-answer">Твоя відповідь
        <input id="competitive-answer" ref={inputRef} type="text" inputMode="numeric" enterKeyHint="send" autoComplete="off" value={answer} disabled={busy} onChange={(event) => {
          const next = event.target.value; setAnswer(next); try { sessionStorage.setItem(draftKey, next); } catch { /* best-effort draft */ }
        }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); if (!busy && answer.trim()) void submit(); } }} />
      </label>
      {error && <p className="competitive-error" role="alert">{error}<button onClick={() => void submit()} disabled={busy || !answer.trim()}>Повторити відповідь</button></p>}
      {(notice || answerFeedback) && <p role="status">{notice || answerFeedback}</p>}
    </article></section>
    <footer className="competitive-action-bar"><button className="student-button" disabled={busy || !answer.trim()} onClick={() => void submit()}>{busy ? "Перевіряємо…" : "Відповісти"}</button></footer>
  </main>;

  if (outcome) {
    const labels = qualifiedLabels(outcome.result.qualified);
    const choices = publishChoices(outcome.result.qualified);
    return <section className="competitive-panel competitive-result" aria-labelledby="competitive-result-title">
      <p className="student-kicker">{outcome.isEndless ? "СУПЕР РІВЕНЬ · РЕЗУЛЬТАТ" : `РІВЕНЬ ${outcome.levelNumber} · РЕЗУЛЬТАТ`}</p><h2 id="competitive-result-title">Твій результат</h2>
      <div className="competitive-score">{outcome.result.score}<small> правильних поспіль</small></div><p>Час забігу: {formatCompetitiveDuration(outcome.result.durationMs)}</p>
      {outcome.result.isPersonalBest && <p className="competitive-best">Новий особистий рекорд!</p>}
      {!outcome.isEndless && outcome.passed !== null && <p className={outcome.passed ? "student-passed" : "student-not-passed"}>{outcome.passed ? "Рівень пройдено — наступний відкрито!" : "Цього разу рівень не пройдено. Спробуй ще!"}</p>}
      {outcome.isEndless && labels.length > 0 && <><p className="competitive-qualified">Ти потрапив у ТОП-10:</p><ul>{labels.map((item) => <li key={item.scope}>{item.label} — {item.rank}-те місце</li>)}</ul>
        <fieldset className="competitive-publish-options" disabled={published || busy}><legend>Чи публікувати результат?</legend>{choices.map((choice) => <label key={choice}><input type="radio" name="competitive-visibility" checked={visibility === choice} onChange={() => setVisibility(choice as ResultVisibility)} />{VISIBILITY_LABEL[choice as ResultVisibility]}</label>)}</fieldset>
        {visibility === "name" && <p className="competitive-privacy-note">Ім’я бачать лише в рейтингу класу.</p>}
        {visibility !== "none" && <button className="student-button" disabled={busy || published} onClick={() => void publish()}>{published ? "Опубліковано" : busy ? "Зберігаємо…" : "Підтвердити публікацію"}</button>}
      </>}
      {error && <p className="competitive-error" role="alert">{error}<button onClick={() => void publish()} disabled={busy}>Повторити</button></p>}{notice && <p role="status">{notice}</p>}
      <button className="competitive-secondary-button" onClick={() => { setOutcome(null); void loadTopics(); }}>До тем</button>
    </section>;
  }

  if (leaderboard) return <section className="competitive-panel competitive-leaderboard" aria-labelledby="competitive-leaderboard-title">
    <header className="competitive-heading"><div><p className="student-kicker">РЕЙТИНГ</p><h2 id="competitive-leaderboard-title">{topics.find((topic) => topic.code === leaderboard.topicCode)?.title ?? "Змагання"}</h2><p>{LEADERBOARD_NAMES[leaderboard.scope]} · для твоєї паралелі</p></div><button className="competitive-secondary-button" onClick={() => setLeaderboard(null)}>← До тем</button></header>
    <nav className="competitive-scope-tabs" aria-label="Область рейтингу">{LEADERBOARD_SCOPES.map((scope) => <button key={scope} aria-pressed={scope === leaderboard.scope} disabled={leaderboardLoading} onClick={() => void openLeaderboard(leaderboard.topicCode, scope)}>{LEADERBOARD_NAMES[scope]}</button>)}</nav>
    {error && <p className="competitive-error" role="alert">{error}<button onClick={() => void openLeaderboard(leaderboard.topicCode, leaderboard.scope)} disabled={leaderboardLoading}>Оновити</button></p>}
    {!leaderboard.rows.length ? <div className="student-empty">Поки що немає опублікованих результатів.</div> : <ol className="competitive-leaderboard-list">{leaderboard.rows.map((row) => <li key={`${row.rank}-${row.displayName}-${row.achievedAt}`}><strong>{row.rank}</strong><span>{row.displayName}</span><b>{row.score}</b><small>{formatCompetitiveDuration(row.durationMs)} · {new Date(row.achievedAt).toLocaleDateString("uk-UA")}</small></li>)}</ol>}
  </section>;

  return <section className="competitive-panel" aria-label="Змагання">
    <div className="competitive-heading"><div><p className="student-kicker">ВИПРОБУЙ СЕБЕ</p><h2>Змагання</h2></div><button className="competitive-refresh" onClick={() => void loadTopics()} disabled={loading} aria-label="Оновити теми">↻</button></div>
    {error && <p className="competitive-error" role="alert">{error}<button onClick={() => void loadTopics()} disabled={loading}>Спробувати знову</button></p>}{notice && <p className="competitive-notice" role="status">{notice}</p>}
    {!loading && !topics.length && !error && <div className="student-empty">Поки немає доступних змагань для твого класу.</div>}
    <div className="competitive-topic-list">{topics.map((topic) => <article className="competitive-topic-card" key={topic.code}>
      <div className="competitive-topic-heading"><div><h3>{topic.title}</h3><p>Для {topic.gradeMin}–{topic.gradeMax} класів</p></div>{topic.myBest && <div className="competitive-my-best"><small>Мій рекорд</small><strong>{topic.myBest.score}</strong><span>{formatCompetitiveDuration(topic.myBest.durationMs)}</span></div>}</div>
      <div className="competitive-levels" aria-label={`Рівні теми ${topic.title}`}>{topic.levels.map((level) => <button key={level.levelNumber} className={`competitive-level ${level.passed ? "passed" : ""}`} disabled={!level.unlocked || busy} title={!level.unlocked ? "Пройди попередній рівень" : undefined} onClick={() => void start(topic, level.levelNumber)}>
        <span>{level.isEndless ? "∞" : level.levelNumber}</span><small>{level.isEndless ? "Супер" : level.passed ? "Пройдено" : level.unlocked ? "Грати" : "Закрито"}</small>
      </button>)}</div>
      <button className="competitive-topic-rating" onClick={() => void openLeaderboard(topic.code, "class")} disabled={leaderboardLoading}>Рейтинг теми →</button>
    </article>)}</div>
  </section>;
}

import { useCallback, useEffect, useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AssignmentResultData, TeacherAttemptTiming } from "./teacher-results.js";
import { formatScore, teacherQuestionScoreLabel } from "../scoring.js";
import {
  formatElapsed,
  formatQuestionSeconds,
  formatStudentAnswer,
  loadAttemptTiming,
  loadAssignmentResults,
  promptText,
  statusLabel,
  summarizeAssignmentResults,
} from "./teacher-results.js";

interface Props {
  client: SupabaseClient;
  teacherId: string;
  assignmentId: string;
  classId: string;
  className: string;
  templateId: string;
  onClose: () => void;
}

type AttemptTimingState =
  | { attemptId: string; status: "loading" | "not_found" | "error" }
  | { attemptId: string; status: "ready"; data: TeacherAttemptTiming };

function dateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("uk-UA", { dateStyle: "short", timeStyle: "short" });
}

export function AssignmentResults({ client, teacherId, assignmentId, classId, className, templateId, onClose }: Props) {
  const [data, setData] = useState<AssignmentResultData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selectedAttemptId, setSelectedAttemptId] = useState("");
  const [attemptTimingState, setAttemptTimingState] = useState<AttemptTimingState | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(false);
    setSelectedAttemptId("");
    try {
      const result = await loadAssignmentResults(client, { assignmentId, classId, templateId });
      if (!result.ok) {
        setError(true);
        setData(null);
      } else {
        setData(result.data);
      }
    } catch {
      setError(true);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [assignmentId, classId, client, templateId]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    if (!selectedAttemptId) {
      setAttemptTimingState(null);
      return;
    }

    let active = true;
    setAttemptTimingState({ attemptId: selectedAttemptId, status: "loading" });
    void loadAttemptTiming(client, { teacherId, attemptId: selectedAttemptId }).then((result) => {
      if (!active) return;
      if (result.ok) {
        setAttemptTimingState({ attemptId: selectedAttemptId, status: "ready", data: result.data });
      } else {
        setAttemptTimingState({
          attemptId: selectedAttemptId,
          status: result.reason === "not_found" ? "not_found" : "error",
        });
      }
    });

    return () => { active = false; };
  }, [client, teacherId, selectedAttemptId]);

  const summary = useMemo(() => data ? summarizeAssignmentResults(data) : null, [data]);
  const selectedAttempt = data?.attempts.find((attempt) => attempt.id === selectedAttemptId && attempt.status === "completed") ?? null;
  const selectedStudent = selectedAttempt && data ? data.students.find((student) => student.id === selectedAttempt.student_id) : null;
  const detailResponses = selectedAttempt && summary ? summary.responsesByAttempt.get(selectedAttempt.id) ?? [] : [];
  const responseByQuestion = new Map(detailResponses.map((response) => [response.question_id, response]));
  const activeTimingState = attemptTimingState?.attemptId === selectedAttemptId ? attemptTimingState : null;
  const timingByQuestionId = useMemo(
    () => new Map(activeTimingState?.status === "ready" ? activeTimingState.data.questions.map((question) => [question.questionId, question]) : []),
    [activeTimingState],
  );

  return <section className="teacher-results" aria-labelledby={`results-title-${assignmentId}`}>
    <header className="teacher-results-heading">
      <div><h4 id={`results-title-${assignmentId}`}>Результати класу «{className}»</h4><p>Учні, спроби та підсумок останніх завершених спроб.</p></div>
      <button type="button" className="teacher-results-close" onClick={onClose} aria-label="Закрити результати">×</button>
    </header>

    {loading ? <p className="teacher-results-state" role="status">Завантажуємо результати…</p> : error ? <div className="teacher-results-error" role="alert">
      <p>Не вдалося завантажити результати. Перевірте з’єднання й доступ до класу.</p>
      <button type="button" onClick={() => void reload()}>Спробувати ще раз</button>
    </div> : summary && data ? <>
      <div className="teacher-results-summary" aria-label="Підсумок призначення">
        <div><span>Завершили</span><strong>{summary.completedStudentCount} із {summary.rows.length}</strong></div>
        <div><span>Середній результат</span><strong>{summary.averagePercent === null ? "—" : `${formatScore(summary.averagePercent)}%`}</strong></div>
        <div><span>Учнів у класі</span><strong>{summary.rows.length}</strong></div>
      </div>

      {summary.mostCommonErrors.length > 0 && <section className="teacher-results-errors" aria-labelledby={`common-errors-${assignmentId}`}>
        <h5 id={`common-errors-${assignmentId}`}>Найчастіші помилки</h5>
        <ul>{summary.mostCommonErrors.slice(0, 5).map(({ question, count }) => <li key={question.id}><span>{promptText(question.prompt)}</span><strong>{count} {count === 1 ? "помилка" : count >= 2 && count <= 4 ? "помилки" : "помилок"}</strong></li>)}</ul>
      </section>}

      {!summary.rows.length ? <p className="teacher-results-state">У цьому класі ще немає учнів.</p> : <>
        <div className="teacher-results-table-wrap">
          <table className="teacher-results-table">
            <thead><tr><th>Учень</th><th>Статус</th><th>Бал / %</th><th>Складено</th><th>Завершено</th><th>Час</th><th>Спроби й деталі</th></tr></thead>
            <tbody>{summary.rows.map((row) => <tr key={row.id}>
              <td data-label="Учень">{row.name}</td>
              <td data-label="Статус"><span className={`teacher-result-status ${row.status}`}>{statusLabel(row.status)}</span></td>
              <td data-label="Бал / %">{row.latestCompleted ? <>{formatScore(row.latestCompleted.score)} / {formatScore(row.latestCompleted.max_score)}<small>{Number(row.latestCompleted.max_score) > 0 ? `${formatScore(Number(row.latestCompleted.score ?? 0) / Number(row.latestCompleted.max_score) * 100)}%` : "—"}</small></> : "—"}</td>
              <td data-label="Складено">{row.latestCompleted?.passed === true ? "Так" : row.latestCompleted?.passed === false ? "Ні" : "—"}</td>
              <td data-label="Завершено">{dateTime(row.latestCompleted?.finished_at)}</td>
              <td data-label="Час">{formatElapsed(row.latestCompleted?.elapsed_ms)}</td>
              <td data-label="Спроби й деталі"><AttemptHistory attempts={row.attempts} studentName={row.name} selectedAttemptId={selectedAttemptId} onSelect={setSelectedAttemptId} /></td>
            </tr>)}</tbody>
          </table>
        </div>

        <div className="teacher-results-cards">
          {summary.rows.map((row) => <article className="teacher-result-card" key={row.id}>
            <div className="teacher-result-card-title"><strong>{row.name}</strong><span className={`teacher-result-status ${row.status}`}>{statusLabel(row.status)}</span></div>
            <dl>
              <div><dt>Бал / відсоток</dt><dd>{row.latestCompleted ? `${formatScore(row.latestCompleted.score)} / ${formatScore(row.latestCompleted.max_score)} · ${Number(row.latestCompleted.max_score) > 0 ? `${formatScore(Number(row.latestCompleted.score ?? 0) / Number(row.latestCompleted.max_score) * 100)}%` : "—"}` : "—"}</dd></div>
              <div><dt>Складено</dt><dd>{row.latestCompleted?.passed === true ? "Так" : row.latestCompleted?.passed === false ? "Ні" : "—"}</dd></div>
              <div><dt>Завершено</dt><dd>{dateTime(row.latestCompleted?.finished_at)}</dd></div>
              <div><dt>Час</dt><dd>{formatElapsed(row.latestCompleted?.elapsed_ms)}</dd></div>
            </dl>
            <AttemptHistory attempts={row.attempts} studentName={row.name} selectedAttemptId={selectedAttemptId} onSelect={setSelectedAttemptId} />
          </article>)}
        </div>
      </>}

      {selectedAttempt && <section className="teacher-attempt-detail" aria-labelledby="teacher-attempt-detail-title">
        <div className="teacher-attempt-detail-heading"><div><h5 id="teacher-attempt-detail-title">Деталі спроби · {selectedStudent?.name ?? "Учень"}</h5><p>{dateTime(selectedAttempt.finished_at)} · {formatScore(selectedAttempt.score)} з {formatScore(selectedAttempt.max_score)} балів · {formatElapsed(selectedAttempt.elapsed_ms)}</p></div><button type="button" aria-label={`Закрити деталі спроби ${selectedStudent?.name ?? "учня"}`} onClick={() => setSelectedAttemptId("")}>Закрити деталі</button></div>
        {activeTimingState?.status === "loading" && <p className="teacher-results-state" role="status">Завантажуємо час на кожне запитання…</p>}
        {activeTimingState?.status === "not_found" && <p className="teacher-results-state" role="status">Дані недоступні.</p>}
        {activeTimingState?.status === "error" && <p className="teacher-results-state" role="status">Не вдалося завантажити час на запитання. Інші дані спроби доступні.</p>}
        {activeTimingState?.status === "ready" && <div className="teacher-results-summary teacher-attempt-timing-summary" aria-label="Зведення часу на запитання">
          <div><span>Середній час</span><strong>{formatQuestionSeconds(activeTimingState.data.summary.avgSeconds)}</strong></div>
          <div><span>Медіана</span><strong>{formatQuestionSeconds(activeTimingState.data.summary.medianSeconds)}</strong></div>
          <div><span>Найшвидше</span><strong>{formatQuestionSeconds(activeTimingState.data.summary.minSeconds)}</strong></div>
          <div><span>Найповільніше</span><strong>{formatQuestionSeconds(activeTimingState.data.summary.maxSeconds)}</strong></div>
        </div>}
        <ol>{(summary.questionsByAttempt.get(selectedAttempt.id) ?? data.questions).map((question, index) => {
          const response = responseByQuestion.get(question.id);
          const correct = response ? response.is_correct === true : false;
          const partial = !correct && Number(response?.awarded_points ?? 0) > 0;
          return <li className={`teacher-attempt-question ${correct ? "correct" : partial ? "partial" : "incorrect"}`} key={question.id}>
            <div className="teacher-attempt-question-title"><strong>{index + 1}. {promptText(question.prompt)}</strong><span>{teacherQuestionScoreLabel(response?.is_correct ?? false, response?.awarded_points ?? 0, question.points)}</span></div>
            <p><span>Відповідь учня:</span> {formatStudentAnswer(question, response)}</p>
            <p className="teacher-attempt-question-timing" aria-label={`Час на відповідь: ${formatQuestionSeconds(timingByQuestionId.get(question.id)?.answerSeconds)}`}><span>Час на відповідь:</span> {formatQuestionSeconds(timingByQuestionId.get(question.id)?.answerSeconds)}</p>
          </li>;
        })}</ol>
      </section>}
    </> : null}
  </section>;
}

function AttemptHistory({ attempts, studentName, selectedAttemptId, onSelect }: {
  attempts: Array<{ id: string; status: string; started_at: string; finished_at: string | null; score: number | string | null; max_score: number | string | null }>;
  studentName: string;
  selectedAttemptId: string;
  onSelect: (attemptId: string) => void;
}) {
  if (!attempts.length) return <span className="teacher-attempt-count">0 спроб</span>;
  return <details className="teacher-attempt-history">
    <summary>{attempts.length} {attempts.length === 1 ? "спроба" : attempts.length >= 2 && attempts.length <= 4 ? "спроби" : "спроб"}</summary>
    <div>{attempts.map((attempt) => attempt.status === "completed" ? <button type="button" key={attempt.id} className={selectedAttemptId === attempt.id ? "selected" : ""} aria-label={`Деталі спроби ${studentName}: ${dateTime(attempt.finished_at)}`} onClick={() => onSelect(attempt.id)}>
      Деталі · {dateTime(attempt.finished_at)} · {formatScore(attempt.score)}/{formatScore(attempt.max_score)}
    </button> : <span key={attempt.id}>{statusLabel(attempt.status)} · {dateTime(attempt.started_at)}</span>)}</div>
  </details>;
}

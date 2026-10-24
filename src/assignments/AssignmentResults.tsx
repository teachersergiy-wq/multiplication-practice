import { useCallback, useEffect, useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AssignmentResultData } from "./teacher-results.js";
import {
  formatElapsed,
  formatStudentAnswer,
  loadAssignmentResults,
  promptText,
  statusLabel,
  summarizeAssignmentResults,
} from "./teacher-results.js";

interface Props {
  client: SupabaseClient;
  assignmentId: string;
  classId: string;
  className: string;
  templateId: string;
  onClose: () => void;
}

function points(value: number | string | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 2 }).format(Number(value));
}

function dateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("uk-UA", { dateStyle: "short", timeStyle: "short" });
}

export function AssignmentResults({ client, assignmentId, classId, className, templateId, onClose }: Props) {
  const [data, setData] = useState<AssignmentResultData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selectedAttemptId, setSelectedAttemptId] = useState("");

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

  const summary = useMemo(() => data ? summarizeAssignmentResults(data) : null, [data]);
  const selectedAttempt = data?.attempts.find((attempt) => attempt.id === selectedAttemptId && attempt.status === "completed") ?? null;
  const selectedStudent = selectedAttempt && data ? data.students.find((student) => student.id === selectedAttempt.student_id) : null;
  const detailResponses = selectedAttempt && summary ? summary.responsesByAttempt.get(selectedAttempt.id) ?? [] : [];
  const responseByQuestion = new Map(detailResponses.map((response) => [response.question_id, response]));

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
        <div><span>Середній результат</span><strong>{summary.averagePercent === null ? "—" : `${points(summary.averagePercent)}%`}</strong></div>
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
              <td data-label="Бал / %">{row.latestCompleted ? <>{points(row.latestCompleted.score)} / {points(row.latestCompleted.max_score)}<small>{Number(row.latestCompleted.max_score) > 0 ? `${points(Number(row.latestCompleted.score ?? 0) / Number(row.latestCompleted.max_score) * 100)}%` : "—"}</small></> : "—"}</td>
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
              <div><dt>Бал / відсоток</dt><dd>{row.latestCompleted ? `${points(row.latestCompleted.score)} / ${points(row.latestCompleted.max_score)} · ${Number(row.latestCompleted.max_score) > 0 ? `${points(Number(row.latestCompleted.score ?? 0) / Number(row.latestCompleted.max_score) * 100)}%` : "—"}` : "—"}</dd></div>
              <div><dt>Складено</dt><dd>{row.latestCompleted?.passed === true ? "Так" : row.latestCompleted?.passed === false ? "Ні" : "—"}</dd></div>
              <div><dt>Завершено</dt><dd>{dateTime(row.latestCompleted?.finished_at)}</dd></div>
              <div><dt>Час</dt><dd>{formatElapsed(row.latestCompleted?.elapsed_ms)}</dd></div>
            </dl>
            <AttemptHistory attempts={row.attempts} studentName={row.name} selectedAttemptId={selectedAttemptId} onSelect={setSelectedAttemptId} />
          </article>)}
        </div>
      </>}

      {selectedAttempt && <section className="teacher-attempt-detail" aria-labelledby="teacher-attempt-detail-title">
        <div className="teacher-attempt-detail-heading"><div><h5 id="teacher-attempt-detail-title">Деталі спроби · {selectedStudent?.name ?? "Учень"}</h5><p>{dateTime(selectedAttempt.finished_at)} · {points(selectedAttempt.score)} з {points(selectedAttempt.max_score)} балів · {formatElapsed(selectedAttempt.elapsed_ms)}</p></div><button type="button" onClick={() => setSelectedAttemptId("")}>Закрити деталі</button></div>
        <ol>{data.questions.map((question, index) => {
          const response = responseByQuestion.get(question.id);
          const correct = response ? response.is_correct === true : false;
          return <li className={`teacher-attempt-question ${correct ? "correct" : "incorrect"}`} key={question.id}>
            <div className="teacher-attempt-question-title"><strong>{index + 1}. {promptText(question.prompt)}</strong><span>{correct ? "Правильно" : "Неправильно"}</span></div>
            <p><span>Відповідь учня:</span> {formatStudentAnswer(question, response)}</p>
            <small>Бали: {points(response?.awarded_points ?? 0)} з {points(question.points)}</small>
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
      Деталі · {dateTime(attempt.finished_at)} · {points(attempt.score)}/{points(attempt.max_score)}
    </button> : <span key={attempt.id}>{statusLabel(attempt.status)} · {dateTime(attempt.started_at)}</span>)}</div>
  </details>;
}

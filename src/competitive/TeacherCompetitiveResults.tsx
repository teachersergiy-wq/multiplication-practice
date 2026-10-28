import { useCallback, useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompetitiveTopic, TeacherCompetitiveRow } from "../../contracts/api";
import { invokeFunction } from "../lib/function-api";
import { formatCompetitiveDuration } from "./competitive-flow.js";
import { competitiveDateTime, sortTeacherCompetitiveRows } from "./teacher-competitive.js";

type TopicOption = Pick<CompetitiveTopic, "code" | "title">;
type LeaderboardItem = { rank: number; displayName: string; score: number; durationMs: number; achievedAt: string };

export function TeacherCompetitiveResults({ client, classId, className }: { client: SupabaseClient; classId: string; className: string }) {
  const [topics, setTopics] = useState<TopicOption[]>([]);
  const [topicCode, setTopicCode] = useState("");
  const [rows, setRows] = useState<TeacherCompetitiveRow[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadResults = useCallback(async () => {
    setLoading(true); setError("");
    const response = await invokeFunction(client, "get-competitive-results", { classId, ...(topicCode ? { topicCode } : {}) });
    setLoading(false);
    if (!response.ok) { setError("Не вдалося завантажити змагальні результати. Перевірте з’єднання й повторіть спробу."); return; }
    setRows(sortTeacherCompetitiveRows(response.data.rows));
  }, [client, classId, topicCode]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const { data, error: topicError } = await client.from("competitive_topics").select("code,title").eq("active", true).order("title");
      if (!active) return;
      if (topicError) { setError("Не вдалося завантажити теми змагань."); return; }
      const available = (data ?? []) as TopicOption[];
      setTopics(available); setTopicCode((current) => current || available[0]?.code || "");
    })();
    return () => { active = false; };
  }, [client]);
  useEffect(() => { if (topicCode) void loadResults(); }, [topicCode, loadResults]);

  async function openClassLeaderboard() {
    if (!topicCode) return;
    setLoading(true); setError("");
    const response = await invokeFunction(client, "get-leaderboard", { topicCode, scope: "class", limit: 10, classId });
    setLoading(false);
    if (!response.ok) { setError("Не вдалося відкрити рейтинг класу."); return; }
    setLeaderboard(response.data.rows);
  }

  return <section className="teacher-competitive" aria-labelledby={`teacher-competitive-${classId}`}>
    <header className="teacher-competitive-heading"><div><h3 id={`teacher-competitive-${classId}`}>Змагання класу «{className}»</h3><p>Спроби й особисті рекорди учнів.</p></div><button type="button" onClick={() => void loadResults()} disabled={loading} aria-label="Оновити результати змагань">↻</button></header>
    {topics.length > 1 && <label className="teacher-competitive-topic">ТЕМА<select value={topicCode} onChange={(event) => { setLeaderboard(null); setTopicCode(event.target.value); }}>{topics.map((topic) => <option key={topic.code} value={topic.code}>{topic.title}</option>)}</select></label>}
    {error && <p className="teacher-competitive-error" role="alert">{error}<button type="button" onClick={() => void loadResults()} disabled={loading}>Спробувати ще раз</button></p>}
    <button className="teacher-competitive-rank-button" type="button" onClick={() => void openClassLeaderboard()} disabled={loading || !topicCode}>Відкрити рейтинг класу</button>
    {leaderboard && <section className="teacher-competitive-leaderboard" aria-label="Рейтинг класу"><div><strong>Рейтинг класу · {topics.find((topic) => topic.code === topicCode)?.title}</strong><button type="button" onClick={() => setLeaderboard(null)} aria-label="Закрити рейтинг класу">×</button></div>{!leaderboard.length ? <p>Поки що немає опублікованих результатів.</p> : <ol>{leaderboard.map((item) => <li key={`${item.rank}-${item.displayName}-${item.achievedAt}`}><strong>{item.rank}</strong><span>{item.displayName}</span><b>{item.score}</b><small>{formatCompetitiveDuration(item.durationMs)} · {new Date(item.achievedAt).toLocaleString("uk-UA", { dateStyle: "short", timeStyle: "short" })}</small></li>)}</ol>}</section>}
    {!loading && !rows.length ? <p className="teacher-competitive-empty">У цьому класі ще немає змагальних спроб.</p> : <>
      <div className="teacher-competitive-table-wrap"><table><thead><tr><th>Учень</th><th>Спроби</th><th>Найкраще</th><th>Останній забіг</th><th>Тривалість</th></tr></thead><tbody>{rows.map((row) => <tr key={row.studentId}><td>{row.fullName}</td><td>{row.attemptCount}</td><td>{row.bestScore}</td><td>{competitiveDateTime(row.lastRunAt)}</td><td>{formatCompetitiveDuration(row.lastRunDurationMs)}</td></tr>)}</tbody></table></div>
      <div className="teacher-competitive-cards">{rows.map((row) => <article key={row.studentId}><h4>{row.fullName}</h4><dl><div><dt>Спроби</dt><dd>{row.attemptCount}</dd></div><div><dt>Найкращий результат</dt><dd>{row.bestScore}</dd></div><div><dt>Останній забіг</dt><dd>{competitiveDateTime(row.lastRunAt)}</dd></div><div><dt>Тривалість</dt><dd>{formatCompetitiveDuration(row.lastRunDurationMs)}</dd></div></dl></article>)}</div>
    </>}
  </section>;
}

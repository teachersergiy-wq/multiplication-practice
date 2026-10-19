import { useMemo, useState } from "react";
import type { AssessmentDraft, QuestionType } from "./domain";
import { grades, isAssessmentDraftCollection, migrateAssessmentDrafts, questionTypeLabels, starterDrafts, subjects } from "./domain";
import { TeacherAccessGate, useTeacherIdentity } from "./auth/TeacherAccessGate";
import { QuestionEditor } from "./questions/QuestionEditor";
import { supabase } from "./lib/supabase";

const storageKey = "learning-studio-assessment-drafts-v2";
const legacyStorageKey = "learning-studio-assessment-drafts-v1";

function readDrafts(): AssessmentDraft[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    const drafts = migrateAssessmentDrafts(value);
    if (drafts) {
      try {
        if (JSON.stringify(drafts) !== JSON.stringify(value)) {
          localStorage.setItem(storageKey, JSON.stringify(drafts));
        }
      } catch {
        // Keep the migrated drafts available in memory if storage is unavailable.
      }
      return drafts;
    }
  } catch {
    // A corrupted local draft is safely ignored.
  }

  try {
    const legacyValue: unknown = JSON.parse(localStorage.getItem(legacyStorageKey) ?? "null");
    const legacyDrafts = migrateAssessmentDrafts(legacyValue, { legacyQuestionTypes: true });
    if (legacyDrafts) {
      try {
        localStorage.setItem(storageKey, JSON.stringify(legacyDrafts));
        if (isAssessmentDraftCollection(legacyValue)) localStorage.removeItem(legacyStorageKey);
      } catch {
        // Keep migrated drafts in memory if storage is unavailable.
      }
      return legacyDrafts;
    }
  } catch {
    // A corrupted legacy draft is safely ignored.
  }

  return starterDrafts;
}

export function App() {
  return supabase ? <TeacherAccessGate><Dashboard /></TeacherAccessGate> : <Dashboard />;
}

function Dashboard() {
  const [drafts, setDrafts] = useState<AssessmentDraft[]>(readDrafts);
  const [subjectCode, setSubjectCode] = useState("mathematics");
  const [grade, setGrade] = useState(3);
  const [questionType, setQuestionType] = useState<QuestionType>("numeric");
  const [title, setTitle] = useState("");
  const [notice, setNotice] = useState("");
  const teacher = useTeacherIdentity();

  const visibleDrafts = useMemo(
    () => drafts.filter((draft) => draft.subjectId === subjectCode && draft.grade === grade),
    [drafts, subjectCode, grade],
  );

  function saveDraft(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const selectedSubject = subjects.find((subject) => subject.code === subjectCode)!;
    const draft: AssessmentDraft = {
      id: crypto.randomUUID(),
      title: title.trim() || `${selectedSubject.name} · ${grade} клас`,
      subjectId: subjectCode,
      grade,
      questionType,
      questionCount: 10,
      durationMinutes: 10,
      updatedAt: "Щойно створено · локальна чернетка",
    };
    const next = [draft, ...drafts];
    setDrafts(next);
    let saved = true;
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      saved = false;
    }
    setTitle("");
    setNotice(saved
      ? "Чернетку збережено на цьому пристрої. Після підключення облікового запису її можна буде синхронізувати."
      : "Чернетка доступна до закриття цієї сторінки, але браузер не дозволив її зберегти.");
    window.setTimeout(() => setNotice(""), 5000);
  }

  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="brand" href="#home" aria-label="Навчальна студія — на головну">
          <span className="brand-mark">н</span><span>навчальна<span className="brand-light">студія</span></span>
        </a>
        <nav className="topnav" aria-label="Головна навігація">
          <a className="active" href="#library">Моя бібліотека</a>
          <a href="#question-editor">Конструктор</a>
          <a href="#classes">Мої класи</a>
        </nav>
        {teacher ? (
          <button className="profile-button" aria-label={`Вийти з облікового запису ${teacher.email}`} onClick={() => void teacher.signOut()}>
            <span>{teacher.displayName.slice(0, 1).toLocaleUpperCase("uk-UA")}</span><span className="profile-name">{teacher.displayName}</span><span aria-hidden="true">↪</span>
          </button>
        ) : <button className="profile-button" aria-label="Профіль учителя"><span>С</span><span className="profile-name">Світлана</span><span aria-hidden="true">⌄</span></button>}
      </header>

      <section className="hero" id="home">
        <div className="hero-copy">
          <div className="eyebrow"><span className="eyebrow-dot" /> ВАША ТВОРЧА МАЙСТЕРНЯ</div>
          <h1>Навчання починається<br />з <em>цікавих запитань.</em></h1>
          <p>Створюйте власні тести з різних предметів, діліться ними з класом і допомагайте дітям навчатися із задоволенням.</p>
          <a className="primary-button" href="#builder"><span>＋</span> Створити тест</a>
          <div className="hero-note"><span className="note-icon">✦</span> Від множення до цікавості до всього світу</div>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="sun-shape" />
          <div className="art-card card-top"><span>1</span><span>2</span><span>3</span><b>?</b></div>
          <div className="art-card card-bottom"><span className="sparkle">✳</span><span>А</span><span>＋</span></div>
          <div className="orbit orbit-one" /><div className="orbit orbit-two" />
          <div className="hero-sticker">Ідеї<br />ростуть<br /><span>тут</span></div>
        </div>
      </section>

      <section className="section subject-section" id="library">
        <div className="section-heading">
          <div><div className="eyebrow muted">ВАШ ПРОСТІР ДЛЯ ІДЕЙ</div><h2>Що вивчатимемо сьогодні?</h2></div>
          <span className="section-aside">Оберіть предмет і клас</span>
        </div>
        <div className="subject-grid">
          {subjects.map((subject) => (
            <button key={subject.code} className={`subject-card ${subject.tone} ${subjectCode === subject.code ? "selected" : ""}`} onClick={() => setSubjectCode(subject.code)}>
              <span className="subject-icon">{subject.icon}</span><span className="subject-arrow">↗</span>
              <strong>{subject.name}</strong><small>{subject.description}</small>
            </button>
          ))}
          <button className="subject-card add-subject" onClick={() => setNotice("Додавання власних предметів з’явиться після підключення бази даних.")}>
            <span className="add-circle">＋</span><strong>Інший предмет</strong><small>Розширюйте свою бібліотеку</small>
          </button>
        </div>
      </section>

      <section className="section workspace" id="builder">
        <div className="workspace-main">
          <div className="section-heading workspace-heading">
            <div><div className="eyebrow muted">ВАША БІБЛІОТЕКА</div><h2>Тести та заготовки</h2></div>
            <label className="grade-select">КЛАС <select value={grade} onChange={(event) => setGrade(Number(event.target.value))}>{grades.map((item) => <option key={item} value={item}>{item} клас</option>)}</select></label>
          </div>
          {visibleDrafts.length ? <div className="draft-list">{visibleDrafts.map((draft) => {
            const subject = subjects.find((item) => item.code === draft.subjectId)!;
            return <article className="draft-row" key={draft.id}><span className={`draft-icon ${subject.tone}`}>{subject.icon}</span><div className="draft-info"><strong>{draft.title}</strong><small>{subject.name} <i>·</i> {draft.grade} клас <i>·</i> {draft.questionCount} запитань</small></div><span className="draft-status">{draft.updatedAt}</span><button className="row-menu" aria-label={`Дії: ${draft.title}`}>···</button></article>;
          })}</div> : <div className="empty-state"><span>✎</span><strong>Тут з’являться ваші тести</strong><p>Створіть першу заготовку для обраного предмета й класу.</p></div>}
        </div>

        <aside className="builder-card">
          <div className="builder-topline"><span className="builder-icon">✧</span><span className="eyebrow muted">ШВИДКИЙ СТАРТ</span></div>
          <h3>Нова заготовка</h3><p>Задайте основу тесту. Запитання можна буде додати й налаштувати пізніше.</p>
          <form onSubmit={saveDraft}>
            <label className="field-label">НАЗВА <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Наприклад, Таблиця множення" /></label>
            <div className="form-row">
              <label className="field-label">ПРЕДМЕТ<select value={subjectCode} onChange={(event) => setSubjectCode(event.target.value)}>{subjects.map((subject) => <option key={subject.code} value={subject.code}>{subject.name}</option>)}</select></label>
              <label className="field-label">КЛАС<select value={grade} onChange={(event) => setGrade(Number(event.target.value))}>{grades.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
            </div>
            <label className="field-label">ТИП ЗАПИТАНЬ<select value={questionType} onChange={(event) => setQuestionType(event.target.value as QuestionType)}>{Object.entries(questionTypeLabels).map(([type, label]) => <option key={type} value={type}>{label}</option>)}</select></label>
            <button className="primary-button form-submit" type="submit">Створити заготовку <span>→</span></button>
          </form>
          <div className="builder-footnote"><span>⌘</span> Чернетки поки зберігаються у цьому браузері</div>
        </aside>
      </section>

      <QuestionEditor />

      <footer className="footer" id="classes"><span>Маленькі кроки — великі відкриття.</span><span>Навчальна студія <b>✳</b> 2026</span></footer>
      {notice && <div className="toast" role="status">{notice}<button onClick={() => setNotice("")} aria-label="Закрити">×</button></div>}
    </main>
  );
}


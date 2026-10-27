-- G12a: competitive topics, runs, best scores. Schema + RLS only (no api_* yet).
-- Do NOT apply to production from agents; owner applies after review.
-- Settings (curve, graceMs, limits) live in competitive_topics.settings jsonb — not hardcoded in functions.

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.competitive_topics (
  code text primary key,
  title text not null,
  subject text not null default 'mathematics',
  grade_min smallint not null check (grade_min between 1 and 11),
  grade_max smallint not null check (grade_max between 1 and 11),
  generator text not null,
  active boolean not null default true,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint competitive_topics_grade_range check (grade_min <= grade_max)
);

comment on table public.competitive_topics is
  'Competitive (self-chosen) topics; settings holds levelCount, curve, limits (G12).';
comment on column public.competitive_topics.settings is
  'jsonb: levelCount, finiteLevels[], graceMs, startLimitMs, stepMs, stepEvery, minLimitMs, minAnswerMs, dailyRunLimit, leaderboardSize, difficultyCurve';

create table if not exists public.competitive_runs (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles (id) on delete cascade,
  topic_code text not null references public.competitive_topics (code),
  level_number smallint not null check (level_number >= 1),
  status text not null default 'in_progress'
    check (status in ('in_progress', 'completed', 'abandoned')),
  score integer not null default 0 check (score >= 0),
  duration_ms integer,
  visibility text not null default 'none'
    check (visibility in ('none', 'nickname', 'anonymous', 'name')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint competitive_runs_finished_ok check (
    (status = 'in_progress' and finished_at is null)
    or (status <> 'in_progress' and finished_at is not null)
  )
);

create index if not exists competitive_runs_student_topic_idx
  on public.competitive_runs (student_id, topic_code, started_at desc);
create index if not exists competitive_runs_topic_level_status_idx
  on public.competitive_runs (topic_code, level_number, status);

-- Current question / key / issue time — never exposed to client roles.
create table if not exists private.competitive_run_state (
  run_id uuid primary key references public.competitive_runs (id) on delete cascade,
  question_id uuid,
  prompt_text text,
  answer_key jsonb,
  issued_at timestamptz,
  limit_ms integer,
  updated_at timestamptz not null default now()
);

create table if not exists public.competitive_best (
  student_id uuid not null references public.profiles (id) on delete cascade,
  topic_code text not null references public.competitive_topics (code),
  best_score integer not null default 0 check (best_score >= 0),
  best_duration_ms integer not null check (best_duration_ms >= 0),
  best_at timestamptz not null default now(),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  -- Highest finite level passed (unlocks next). 0 = none yet.
  max_level_passed smallint not null default 0 check (max_level_passed >= 0),
  primary key (student_id, topic_code)
);

-- ---------------------------------------------------------------------------
-- Seed: multiplication_table (grades 3–11). Tunables in settings only.
-- ---------------------------------------------------------------------------

insert into public.competitive_topics (code, title, subject, grade_min, grade_max, generator, active, settings)
values (
  'multiplication_table',
  'Таблиця множення',
  'mathematics',
  3,
  11,
  'multiplication_table',
  true,
  jsonb_build_object(
    'levelCount', 6,
    'finiteLevels', jsonb_build_array(
      jsonb_build_object('levelNumber', 1, 'questionCount', 10, 'secondsPerQuestion', 8, 'passPercent', 80),
      jsonb_build_object('levelNumber', 2, 'questionCount', 12, 'secondsPerQuestion', 8, 'passPercent', 80),
      jsonb_build_object('levelNumber', 3, 'questionCount', 15, 'secondsPerQuestion', 10, 'passPercent', 80),
      jsonb_build_object('levelNumber', 4, 'questionCount', 15, 'secondsPerQuestion', 10, 'passPercent', 80),
      jsonb_build_object('levelNumber', 5, 'questionCount', 20, 'secondsPerQuestion', 12, 'passPercent', 80)
    ),
    'graceMs', 1000,
    'startLimitMs', 7000,
    'stepMs', 500,
    'stepEvery', 5,
    'minLimitMs', 1000,
    'minAnswerMs', 300,
    'dailyRunLimit', 200,
    'leaderboardSize', 10,
    'difficultyCurve', jsonb_build_array(
      1,1,2,1,2,2,3,1,2,3,3,2,3,2,4,1,3,4,2,5,3,4,5,4,2,1,2,4,5,3,
      5,4,3,5,4,3,5,4,2,5,1,4,5,4,3,4,5,4,5,3,5,2,4,5,4,1,3,5,4,4,
      5,3,4,5,4,2,4,5,4,3,4,5,4,4,5,5,1,4
    )
  )
)
on conflict (code) do update set
  title = excluded.title,
  grade_min = excluded.grade_min,
  grade_max = excluded.grade_max,
  generator = excluded.generator,
  active = excluded.active,
  settings = excluded.settings;

-- ---------------------------------------------------------------------------
-- Grants: browser roles read limited rows via RLS; no write; private locked.
-- ---------------------------------------------------------------------------

revoke all on table public.competitive_topics from public, anon, authenticated;
revoke all on table public.competitive_runs from public, anon, authenticated;
revoke all on table public.competitive_best from public, anon, authenticated;
revoke all on table private.competitive_run_state from public, anon, authenticated;

grant select on table public.competitive_topics to authenticated;
grant select on table public.competitive_runs to authenticated;
grant select on table public.competitive_best to authenticated;
-- no insert/update/delete for authenticated on any of these

grant all on table public.competitive_topics to service_role;
grant all on table public.competitive_runs to service_role;
grant all on table public.competitive_best to service_role;
grant all on table private.competitive_run_state to service_role;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.competitive_topics enable row level security;
alter table public.competitive_runs enable row level security;
alter table public.competitive_best enable row level security;
alter table private.competitive_run_state enable row level security;

-- Topics: any signed-in user may read active topics (grade filter is application-side / api).
drop policy if exists competitive_topics_select_active on public.competitive_topics;
create policy competitive_topics_select_active
  on public.competitive_topics
  for select
  to authenticated
  using (active = true);

-- Runs: student sees own; teacher sees students in their classes.
drop policy if exists competitive_runs_select_own_or_teacher on public.competitive_runs;
create policy competitive_runs_select_own_or_teacher
  on public.competitive_runs
  for select
  to authenticated
  using (
    student_id = auth.uid()
    or exists (
      select 1
      from public.class_students cs
      join public.class_teachers ct on ct.class_id = cs.class_id
      where cs.student_id = competitive_runs.student_id
        and ct.teacher_id = auth.uid()
    )
  );

-- Best: same visibility as runs.
drop policy if exists competitive_best_select_own_or_teacher on public.competitive_best;
create policy competitive_best_select_own_or_teacher
  on public.competitive_best
  for select
  to authenticated
  using (
    student_id = auth.uid()
    or exists (
      select 1
      from public.class_students cs
      join public.class_teachers ct on ct.class_id = cs.class_id
      where cs.student_id = competitive_best.student_id
        and ct.teacher_id = auth.uid()
    )
  );

-- No INSERT/UPDATE/DELETE policies for authenticated → RLS denies writes.
-- private.competitive_run_state: no policies for authenticated/anon → deny all.

-- Public leaderboard is intentionally NOT readable from tables; only via api_get_leaderboard (G12c).

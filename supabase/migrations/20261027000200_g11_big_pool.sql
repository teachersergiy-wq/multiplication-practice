-- G11 (issue #84): BIG multiplication pool — bank, attempt sample, bulk edit.
-- NOT applied to production by agents.

-- 1. difficulty on questions
alter table public.assessment_questions
  add column if not exists difficulty smallint
  constraint assessment_questions_difficulty_range
    check (difficulty is null or (difficulty between 1 and 5));

-- 2. per-attempt question sample
create table if not exists public.assessment_attempt_questions (
  attempt_id uuid not null references public.assessment_attempts (id) on delete cascade,
  question_id uuid not null references public.assessment_questions (id) on delete cascade,
  position integer not null check (position > 0),
  primary key (attempt_id, question_id),
  unique (attempt_id, position)
);

create index if not exists assessment_attempt_questions_attempt_pos_idx
  on public.assessment_attempt_questions (attempt_id, position);

alter table public.assessment_attempt_questions enable row level security;

revoke all on table public.assessment_attempt_questions from public, anon, authenticated;
grant select on table public.assessment_attempt_questions to authenticated;
grant all on table public.assessment_attempt_questions to service_role;

drop policy if exists attempt_questions_select_student on public.assessment_attempt_questions;
create policy attempt_questions_select_student
on public.assessment_attempt_questions
for select to authenticated
using (
  exists (
    select 1 from public.assessment_attempts a
    where a.id = attempt_id and a.student_id = auth.uid()
  )
  or exists (
    select 1
    from public.assessment_attempts a
    join public.assessment_assignments asg on asg.id = a.assignment_id
    join public.assessment_templates t on t.id = asg.template_id
    where a.id = attempt_id and t.teacher_id = auth.uid()
  )
);

-- NOTE: full bank/bulk/start/finalize SQL follows in 20261027000300_g11_big_pool_logic.sql

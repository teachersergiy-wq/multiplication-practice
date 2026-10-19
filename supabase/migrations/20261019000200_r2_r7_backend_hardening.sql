-- R2–R7 backend hardening (API_CONTRACT §8).
-- NOT applied to production by agents. Local / owner-approved branch only.

create table if not exists private.allowed_teachers (
  email text primary key,
  note text not null default '',
  created_at timestamptz not null default now(),
  constraint allowed_teachers_email_lower check (email = lower(trim(email)))
);

alter table private.allowed_teachers enable row level security;
revoke all on table private.allowed_teachers from public, anon, authenticated;
grant all on table private.allowed_teachers to service_role;

revoke insert, update, delete on public.assessment_questions from anon, authenticated;

drop policy if exists questions_read_owner_or_assigned_student on public.assessment_questions;
drop policy if exists questions_create_owner_draft on public.assessment_questions;
drop policy if exists questions_update_owner_draft on public.assessment_questions;
drop policy if exists questions_delete_owner_draft on public.assessment_questions;

create policy questions_select_owner on public.assessment_questions
for select to authenticated
using (private.owns_template(template_id));

drop policy if exists templates_update_draft_owner on public.assessment_templates;
create policy templates_update_draft_owner on public.assessment_templates
for update to authenticated
using (teacher_id = (select auth.uid()) and status = 'draft')
with check (teacher_id = (select auth.uid()) and status = 'draft');

drop policy if exists templates_delete_owner on public.assessment_templates;
create policy templates_delete_owner on public.assessment_templates
for delete to authenticated
using (teacher_id = (select auth.uid()) and status = 'draft');

create or replace function private.enforce_response_scores_null_until_finish()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_status public.attempt_status;
  v_mode public.assessment_mode;
begin
  select at.status, t.mode
    into v_status, v_mode
  from public.assessment_attempts at
  join public.assessment_assignments a on a.id = at.assignment_id
  join public.assessment_templates t on t.id = a.template_id
  where at.id = new.attempt_id;

  if v_mode = 'graded' and v_status = 'in_progress' then
    if new.is_correct is not null or new.awarded_points is not null then
      raise exception 'scores forbidden until attempt is finished';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_response_scores_null_until_finish() from public, anon, authenticated;

drop trigger if exists trg_response_scores_null on public.assessment_responses;
create trigger trg_response_scores_null
before insert or update on public.assessment_responses
for each row execute function private.enforce_response_scores_null_until_finish();

create unique index if not exists attempts_one_in_progress_per_student
on public.assessment_attempts (assignment_id, student_id)
where status = 'in_progress';

create or replace function private.save_question_with_key(
  p_template_id uuid,
  p_question_id uuid,
  p_position integer,
  p_question_type public.question_type,
  p_prompt jsonb,
  p_choices jsonb,
  p_points numeric,
  p_time_limit_seconds integer,
  p_answer_key jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_answer_key is null then
    raise exception 'answer_key required';
  end if;

  if p_question_id is null then
    insert into public.assessment_questions (
      template_id, position, question_type, prompt, choices, points, time_limit_seconds
    ) values (
      p_template_id, p_position, p_question_type, p_prompt, coalesce(p_choices, '[]'::jsonb),
      coalesce(p_points, 1), p_time_limit_seconds
    ) returning id into v_id;
  else
    update public.assessment_questions set
      position = p_position,
      question_type = p_question_type,
      prompt = p_prompt,
      choices = coalesce(p_choices, '[]'::jsonb),
      points = coalesce(p_points, 1),
      time_limit_seconds = p_time_limit_seconds
    where id = p_question_id and template_id = p_template_id
    returning id into v_id;
    if v_id is null then
      raise exception 'question not found';
    end if;
  end if;

  insert into private.assessment_answer_keys (question_id, answer_key, checker_version)
  values (v_id, p_answer_key, 1)
  on conflict (question_id) do update
    set answer_key = excluded.answer_key,
        checker_version = excluded.checker_version;

  return v_id;
end;
$$;

create or replace function private.publish_assessment(p_template_id uuid)
returns void
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  if not exists (
    select 1 from public.assessment_questions q where q.template_id = p_template_id
  ) then
    raise exception 'incomplete_assessment: no questions';
  end if;

  if exists (
    select 1
    from public.assessment_questions q
    left join private.assessment_answer_keys k on k.question_id = q.id
    where q.template_id = p_template_id and k.question_id is null
  ) then
    raise exception 'incomplete_assessment: missing answer keys';
  end if;

  update public.assessment_templates
    set status = 'published', updated_at = now()
  where id = p_template_id and status = 'draft';

  if not found then
    raise exception 'conflict: template not draft or missing';
  end if;
end;
$$;

create or replace function private.finalize_attempt(p_attempt_id uuid)
returns void
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  raise exception 'not_implemented: finalize_attempt';
end;
$$;

create or replace function private.create_student_records(
  p_student_id uuid,
  p_full_name text,
  p_login_code text,
  p_class_id uuid,
  p_nickname text
)
returns void
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  insert into public.profiles (id, role, full_name, generated_nickname, student_login_code)
  values (p_student_id, 'student', p_full_name, p_nickname, p_login_code);

  insert into public.class_students (student_id, class_id)
  values (p_student_id, p_class_id);
end;
$$;

revoke all on function private.save_question_with_key(uuid, uuid, integer, public.question_type, jsonb, jsonb, numeric, integer, jsonb) from public, anon, authenticated;
revoke all on function private.publish_assessment(uuid) from public, anon, authenticated;
revoke all on function private.finalize_attempt(uuid) from public, anon, authenticated;
revoke all on function private.create_student_records(uuid, text, text, uuid, text) from public, anon, authenticated;

grant execute on function private.save_question_with_key(uuid, uuid, integer, public.question_type, jsonb, jsonb, numeric, integer, jsonb) to service_role;
grant execute on function private.publish_assessment(uuid) to service_role;
grant execute on function private.finalize_attempt(uuid) to service_role;
grant execute on function private.create_student_records(uuid, text, text, uuid, text) to service_role;

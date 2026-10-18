-- General assessment platform: subjects and class levels share one test engine.
-- Multiplication is represented as subject-specific configuration, not a separate app model.

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

create type public.user_role as enum ('teacher', 'student');
create type public.assessment_status as enum ('draft', 'published', 'archived');
create type public.assessment_mode as enum ('practice', 'graded');
create type public.question_type as enum ('numeric', 'short_answer', 'single_choice', 'multiple_choice', 'true_false');
create type public.attempt_status as enum ('in_progress', 'completed', 'abandoned');

create table public.schools (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 160),
  created_at timestamptz not null default now()
);

create table public.classes (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  created_at timestamptz not null default now(),
  unique (school_id, name)
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role public.user_role not null,
  full_name text not null check (length(trim(full_name)) between 1 and 160),
  generated_nickname text not null unique,
  student_login_code text unique,
  created_at timestamptz not null default now(),
  constraint student_login_code_by_role check (
    (role = 'student' and student_login_code is not null)
    or (role = 'teacher' and student_login_code is null)
  )
);

create table public.class_teachers (
  class_id uuid not null references public.classes(id) on delete cascade,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  primary key (class_id, teacher_id)
);

create table public.class_students (
  student_id uuid primary key references public.profiles(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade
);

create table public.subjects (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z][a-z0-9_-]{1,39}$'),
  name text not null check (length(trim(name)) between 1 and 100),
  description text not null default '',
  icon text not null default '✳',
  is_system boolean not null default false,
  active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint custom_subject_owner check (is_system or created_by is not null)
);

insert into public.subjects (code, name, description, icon, is_system) values
  ('mathematics', 'Математика', 'Множення, дроби, задачі', '＋', true),
  ('ukrainian-language', 'Українська мова', 'Мова, читання, правопис', 'А', true),
  ('english-language', 'Англійська мова', 'Слова, граматика, читання', 'Aa', true),
  ('science', 'Я досліджую світ', 'Природа, людина, суспільство', '✳', true);

create table public.class_subjects (
  class_id uuid not null references public.classes(id) on delete cascade,
  subject_id uuid not null references public.subjects(id) on delete restrict,
  grade_level smallint not null check (grade_level between 1 and 12),
  created_at timestamptz not null default now(),
  primary key (class_id, subject_id)
);

create table public.assessment_templates (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  subject_id uuid not null references public.subjects(id) on delete restrict,
  grade_level smallint not null check (grade_level between 1 and 12),
  title text not null check (length(trim(title)) between 1 and 180),
  description text not null default '',
  mode public.assessment_mode not null default 'practice',
  status public.assessment_status not null default 'draft',
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.assessment_questions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.assessment_templates(id) on delete cascade,
  position integer not null check (position > 0),
  question_type public.question_type not null,
  prompt jsonb not null check (jsonb_typeof(prompt) = 'object'),
  choices jsonb not null default '[]'::jsonb check (jsonb_typeof(choices) = 'array'),
  points numeric(7,2) not null default 1 check (points > 0),
  time_limit_seconds integer check (time_limit_seconds is null or time_limit_seconds between 1 and 3600),
  created_at timestamptz not null default now(),
  unique (template_id, position)
);

create table private.assessment_answer_keys (
  question_id uuid primary key references public.assessment_questions(id) on delete cascade,
  answer_key jsonb not null,
  checker_version smallint not null default 1 check (checker_version > 0)
);
revoke all on private.assessment_answer_keys from public, anon, authenticated;
grant all on private.assessment_answer_keys to service_role;

create table public.assessment_assignments (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.assessment_templates(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  assigned_by uuid not null references public.profiles(id),
  opens_at timestamptz,
  closes_at timestamptz,
  allow_retries boolean not null default true,
  created_at timestamptz not null default now(),
  unique (template_id, class_id),
  check (closes_at is null or opens_at is null or closes_at > opens_at)
);

create table public.assessment_attempts (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assessment_assignments(id) on delete restrict,
  student_id uuid not null references public.profiles(id) on delete cascade,
  status public.attempt_status not null default 'in_progress',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  score numeric(9,2),
  max_score numeric(9,2),
  passed boolean,
  elapsed_ms integer,
  created_at timestamptz not null default now(),
  check ((status = 'in_progress' and finished_at is null) or (status <> 'in_progress' and finished_at is not null))
);

create table public.assessment_responses (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.assessment_attempts(id) on delete cascade,
  question_id uuid not null references public.assessment_questions(id) on delete restrict,
  response jsonb not null default 'null'::jsonb,
  is_correct boolean,
  awarded_points numeric(7,2),
  answered_at timestamptz not null default now(),
  unique (attempt_id, question_id)
);

create table public.multiplication_level_configs (
  subject_id uuid not null references public.subjects(id) on delete cascade,
  grade_level smallint not null check (grade_level between 1 and 12),
  level_number smallint not null check (level_number between 1 and 5),
  question_count smallint not null check (question_count > 0),
  seconds_per_question smallint not null check (seconds_per_question > 0),
  max_errors smallint not null check (max_errors >= 0),
  pass_percent smallint not null check (pass_percent between 1 and 100),
  min_factor smallint not null default 1,
  max_factor smallint not null default 10,
  active boolean not null default true,
  primary key (subject_id, grade_level, level_number),
  check (min_factor > 0 and max_factor >= min_factor)
);

insert into public.multiplication_level_configs
  (subject_id, grade_level, level_number, question_count, seconds_per_question, max_errors, pass_percent, min_factor, max_factor)
select s.id, 3, v.level_number, v.question_count, v.seconds_per_question, v.max_errors, v.pass_percent, v.min_factor, v.max_factor
from public.subjects s
cross join (values
  (1, 10, 15, 3, 70, 1, 10),
  (2, 15, 12, 3, 80, 1, 10),
  (3, 20, 10, 2, 85, 2, 10),
  (4, 25, 8, 2, 90, 2, 12),
  (5, 30, 5, 1, 95, 2, 12)
) as v(level_number, question_count, seconds_per_question, max_errors, pass_percent, min_factor, max_factor)
where s.code = 'mathematics';

create index class_teachers_teacher_idx on public.class_teachers(teacher_id, class_id);
create index class_students_class_idx on public.class_students(class_id, student_id);
create index class_subjects_subject_grade_idx on public.class_subjects(subject_id, grade_level);
create index assessment_templates_owner_updated_idx on public.assessment_templates(teacher_id, updated_at desc);
create index assessment_templates_subject_grade_idx on public.assessment_templates(subject_id, grade_level, status);
create index assessment_questions_template_position_idx on public.assessment_questions(template_id, position);
create index assignments_class_idx on public.assessment_assignments(class_id, created_at desc);
create index attempts_student_started_idx on public.assessment_attempts(student_id, started_at desc);
create index attempts_assignment_status_idx on public.assessment_attempts(assignment_id, status);
create index responses_attempt_idx on public.assessment_responses(attempt_id, question_id);

create or replace function private.can_manage_class(p_class_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.class_teachers ct where ct.class_id = p_class_id and ct.teacher_id = auth.uid());
$$;

create or replace function private.is_class_student(p_class_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.class_students cs where cs.class_id = p_class_id and cs.student_id = auth.uid());
$$;

create or replace function private.owns_template(p_template_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.assessment_templates t where t.id = p_template_id and t.teacher_id = auth.uid());
$$;

create or replace function private.can_read_template(p_template_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.assessment_assignments a
    join public.assessment_templates t on t.id = a.template_id
    join public.class_subjects cs on cs.class_id = a.class_id and cs.subject_id = t.subject_id and cs.grade_level = t.grade_level
    where a.template_id = p_template_id and t.status = 'published' and private.is_class_student(a.class_id)
      and (a.opens_at is null or a.opens_at <= now()) and (a.closes_at is null or a.closes_at > now())
  );
$$;

create or replace function public.register_teacher(p_full_name text, p_school_name text, p_class_name text)
returns jsonb language plpgsql security definer set search_path = public, private, pg_temp as $$
declare v_school uuid; v_class uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if exists (select 1 from public.profiles where id = auth.uid()) then raise exception 'profile already exists'; end if;
  if length(trim(coalesce(p_full_name, ''))) < 2 then raise exception 'name required'; end if;
  insert into public.profiles(id, role, full_name, generated_nickname)
  values (auth.uid(), 'teacher', trim(p_full_name), 'Учитель-' || substr(replace(auth.uid()::text, '-', ''), 1, 8));
  insert into public.schools(name) values (coalesce(nullif(trim(p_school_name), ''), 'Моя школа')) returning id into v_school;
  insert into public.classes(school_id, name) values (v_school, coalesce(nullif(trim(p_class_name), ''), 'Мій клас')) returning id into v_class;
  insert into public.class_teachers(class_id, teacher_id) values (v_class, auth.uid());
  return jsonb_build_object('school_id', v_school, 'class_id', v_class);
end;
$$;
revoke all on function public.register_teacher(text, text, text) from public, anon;
grant execute on function public.register_teacher(text, text, text) to authenticated;

alter table public.schools enable row level security;
alter table public.classes enable row level security;
alter table public.profiles enable row level security;
alter table public.class_teachers enable row level security;
alter table public.class_students enable row level security;
alter table public.subjects enable row level security;
alter table public.class_subjects enable row level security;
alter table public.assessment_templates enable row level security;
alter table public.assessment_questions enable row level security;
alter table public.assessment_assignments enable row level security;
alter table public.assessment_attempts enable row level security;
alter table public.assessment_responses enable row level security;
alter table public.multiplication_level_configs enable row level security;

create policy schools_read_member on public.schools for select to authenticated using (
  exists (select 1 from public.classes c where c.school_id = schools.id and (private.can_manage_class(c.id) or private.is_class_student(c.id)))
);
create policy classes_read_member on public.classes for select to authenticated using (private.can_manage_class(id) or private.is_class_student(id));
create policy profiles_read_self_or_teacher on public.profiles for select to authenticated using (
  id = (select auth.uid()) or exists (
    select 1 from public.class_students cs where cs.student_id = profiles.id and private.can_manage_class(cs.class_id)
  )
);
create policy class_teachers_read_related on public.class_teachers for select to authenticated using (
  teacher_id = (select auth.uid()) or private.can_manage_class(class_id)
);
create policy class_students_read_self_or_teacher on public.class_students for select to authenticated using (
  student_id = (select auth.uid()) or private.can_manage_class(class_id)
);

create policy subjects_read_active on public.subjects for select to authenticated using (active and (is_system or created_by = (select auth.uid())));
create policy subjects_create_custom on public.subjects for insert to authenticated with check (
  is_system = false and created_by = (select auth.uid()) and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'teacher')
);
create policy subjects_update_custom on public.subjects for update to authenticated using (not is_system and created_by = (select auth.uid()))
with check (not is_system and created_by = (select auth.uid()));

create policy class_subjects_read_related on public.class_subjects for select to authenticated using (
  private.can_manage_class(class_id) or private.is_class_student(class_id)
);
create policy class_subjects_manage on public.class_subjects for all to authenticated using (private.can_manage_class(class_id))
with check (private.can_manage_class(class_id));

create policy templates_read_owner_or_assigned_student on public.assessment_templates for select to authenticated using (
  teacher_id = (select auth.uid()) or private.can_read_template(id)
);
create policy templates_create_owner on public.assessment_templates for insert to authenticated with check (
  teacher_id = (select auth.uid()) and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'teacher')
);
create policy templates_update_owner on public.assessment_templates for update to authenticated using (teacher_id = (select auth.uid()))
with check (teacher_id = (select auth.uid()));
create policy templates_delete_owner on public.assessment_templates for delete to authenticated using (teacher_id = (select auth.uid()));

create policy questions_read_owner_or_assigned_student on public.assessment_questions for select to authenticated using (
  private.owns_template(template_id) or private.can_read_template(template_id)
);
create policy questions_create_owner_draft on public.assessment_questions for insert to authenticated with check (
  private.owns_template(template_id) and exists (select 1 from public.assessment_templates t where t.id = template_id and t.status = 'draft')
);
create policy questions_update_owner_draft on public.assessment_questions for update to authenticated using (
  private.owns_template(template_id) and exists (select 1 from public.assessment_templates t where t.id = template_id and t.status = 'draft')
) with check (private.owns_template(template_id));
create policy questions_delete_owner_draft on public.assessment_questions for delete to authenticated using (
  private.owns_template(template_id) and exists (select 1 from public.assessment_templates t where t.id = template_id and t.status = 'draft')
);

create policy assignments_read_teacher_or_class_student on public.assessment_assignments for select to authenticated using (
  private.can_manage_class(class_id) or private.is_class_student(class_id)
);
create policy assignments_create_teacher_published_matching_grade on public.assessment_assignments for insert to authenticated with check (
  private.can_manage_class(class_id) and assigned_by = (select auth.uid()) and exists (
    select 1 from public.assessment_templates t join public.class_subjects cs
      on cs.class_id = assessment_assignments.class_id and cs.subject_id = t.subject_id and cs.grade_level = t.grade_level
    where t.id = assessment_assignments.template_id and t.teacher_id = auth.uid() and t.status = 'published'
  )
);
create policy assignments_update_teacher on public.assessment_assignments for update to authenticated using (
  private.can_manage_class(class_id) and assigned_by = (select auth.uid())
) with check (private.can_manage_class(class_id) and assigned_by = (select auth.uid()));
create policy assignments_delete_teacher on public.assessment_assignments for delete to authenticated using (
  private.can_manage_class(class_id) and assigned_by = (select auth.uid())
);

create policy attempts_read_owner_or_teacher on public.assessment_attempts for select to authenticated using (
  student_id = (select auth.uid()) or exists (
    select 1 from public.assessment_assignments a where a.id = assignment_id and private.can_manage_class(a.class_id)
  )
);
create policy responses_read_owner_or_teacher on public.assessment_responses for select to authenticated using (
  exists (select 1 from public.assessment_attempts at where at.id = attempt_id and (
    at.student_id = (select auth.uid()) or exists (
      select 1 from public.assessment_assignments a where a.id = at.assignment_id and private.can_manage_class(a.class_id)
    )
  ))
);
create policy multiplication_configs_read on public.multiplication_level_configs for select to authenticated using (active);
create policy multiplication_configs_manage_teacher on public.multiplication_level_configs for all to authenticated
using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'teacher'))
with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'teacher'));

grant usage on schema public to authenticated;
grant select on public.schools, public.classes, public.profiles, public.class_teachers, public.class_students,
  public.subjects, public.class_subjects, public.assessment_templates, public.assessment_questions,
  public.assessment_assignments, public.assessment_attempts, public.assessment_responses,
  public.multiplication_level_configs to authenticated;
grant insert, update, delete on public.subjects, public.class_subjects, public.assessment_templates,
  public.assessment_questions, public.assessment_assignments to authenticated;
revoke insert, update, delete on public.assessment_attempts, public.assessment_responses from anon, authenticated;

grant execute on function private.can_manage_class(uuid) to authenticated;
grant execute on function private.is_class_student(uuid) to authenticated;
grant execute on function private.owns_template(uuid) to authenticated;
grant execute on function private.can_read_template(uuid) to authenticated;

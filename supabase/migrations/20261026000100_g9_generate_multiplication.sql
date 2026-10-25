-- G9 (issue #72): level configs for grades 3/5–9; generate-multiplication-test RPC.
-- NOT applied to production by agents.

-- Owner table (2026-10-25): update grade 3, insert grades 5–9 for mathematics.
with math as (
  select id as subject_id from public.subjects where code = 'mathematics' limit 1
), src(grade_level, level_number, question_count, seconds_per_question, max_errors, pass_percent, min_factor, max_factor) as (
  values
    (3, 1, 10, 15, 3, 70, 1, 10),
    (3, 2, 15, 12, 3, 80, 1, 10),
    (3, 3, 20, 10, 2, 90, 2, 10),
    (3, 4, 25, 8, 2, 92, 2, 9),
    (3, 5, 30, 5, 1, 95, 3, 9),
    (5, 1, 10, 15, 3, 70, 1, 10),
    (5, 2, 15, 12, 3, 80, 1, 10),
    (5, 3, 20, 10, 2, 90, 1, 9),
    (5, 4, 25, 8, 2, 92, 2, 9),
    (5, 5, 30, 5, 1, 95, 3, 9),
    (6, 1, 10, 15, 3, 70, 1, 10),
    (6, 2, 15, 12, 3, 80, 2, 9),
    (6, 3, 20, 10, 2, 90, 2, 9),
    (6, 4, 25, 8, 2, 92, 3, 9),
    (6, 5, 30, 5, 1, 95, 3, 9),
    (7, 1, 10, 15, 3, 70, 2, 9),
    (7, 2, 15, 12, 3, 80, 2, 9),
    (7, 3, 20, 10, 2, 90, 3, 9),
    (7, 4, 25, 8, 2, 92, 3, 9),
    (7, 5, 30, 5, 1, 95, 3, 9),
    (8, 1, 10, 15, 3, 70, 2, 11),
    (8, 2, 15, 12, 3, 80, 2, 11),
    (8, 3, 20, 10, 2, 90, 3, 11),
    (8, 4, 25, 8, 2, 92, 3, 11),
    (8, 5, 30, 5, 1, 95, 3, 11),
    (9, 1, 10, 15, 3, 70, 2, 11),
    (9, 2, 15, 12, 3, 80, 3, 11),
    (9, 3, 20, 10, 2, 90, 3, 11),
    (9, 4, 25, 8, 2, 92, 3, 11),
    (9, 5, 30, 5, 1, 95, 3, 11)
)
insert into public.multiplication_level_configs (
  subject_id, grade_level, level_number, question_count, seconds_per_question,
  max_errors, pass_percent, min_factor, max_factor, active
)
select
  m.subject_id, s.grade_level, s.level_number, s.question_count, s.seconds_per_question,
  s.max_errors, s.pass_percent, s.min_factor, s.max_factor, true
from math m
cross join src s
on conflict (subject_id, grade_level, level_number) do update set
  question_count = excluded.question_count,
  seconds_per_question = excluded.seconds_per_question,
  max_errors = excluded.max_errors,
  pass_percent = excluded.pass_percent,
  min_factor = excluded.min_factor,
  max_factor = excluded.max_factor,
  active = true;

create or replace function public.api_generate_multiplication_test(
  p_teacher_id uuid,
  p_subject_id uuid,
  p_grade_level integer,
  p_level_number integer,
  p_mode public.assessment_mode,
  p_title text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_role public.user_role;
  v_subj_code text;
  v_subj_active boolean;
  v_cfg public.multiplication_level_configs%rowtype;
  v_title text;
  v_settings jsonb;
  v_template_id uuid;
  v_daily integer;
  v_pair record;
  v_pos integer := 0;
  v_qid uuid;
  v_need integer;
  v_have integer;
  v_a integer;
  v_b integer;
begin
  if p_teacher_id is null or p_subject_id is null then
    raise exception 'invalid_request: teacherId and subjectId required' using errcode = 'P0001';
  end if;
  if p_grade_level is null or p_grade_level < 1 or p_grade_level > 11 then
    raise exception 'invalid_request: gradeLevel must be 1–11' using errcode = 'P0001';
  end if;
  if p_level_number is null or p_level_number < 1 or p_level_number > 5 then
    raise exception 'invalid_request: levelNumber must be 1–5' using errcode = 'P0001';
  end if;
  if p_mode is null then
    raise exception 'invalid_request: mode required' using errcode = 'P0001';
  end if;

  select role into v_role from public.profiles where id = p_teacher_id;
  if v_role is distinct from 'teacher' then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  select code, active into v_subj_code, v_subj_active
  from public.subjects where id = p_subject_id;
  if v_subj_code is null or not coalesce(v_subj_active, false) or v_subj_code is distinct from 'mathematics' then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  select c.* into v_cfg
  from public.multiplication_level_configs c
  where c.subject_id = p_subject_id
    and c.level_number = p_level_number
    and c.active
    and c.grade_level <= p_grade_level
  order by c.grade_level desc
  limit 1;

  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  select count(*)::integer into v_daily
  from public.assessment_templates t
  where t.teacher_id = p_teacher_id
    and t.created_at >= date_trunc('day', now() at time zone 'utc')
    and t.created_at < date_trunc('day', now() at time zone 'utc') + interval '1 day'
    and coalesce(t.settings->>'source', '') = 'generate-multiplication-test';

  if v_daily >= 30 then
    raise exception 'conflict: daily generate limit' using errcode = 'P0001';
  end if;

  v_title := nullif(trim(coalesce(p_title, '')), '');
  if v_title is null then
    v_title := format('Множення: рівень %s', p_level_number);
  end if;
  if length(v_title) > 120 then
    raise exception 'invalid_request: title length 1–120' using errcode = 'P0001';
  end if;

  v_settings := jsonb_build_object(
    'passPercent', v_cfg.pass_percent,
    'maxErrors', v_cfg.max_errors,
    'source', 'generate-multiplication-test',
    'levelNumber', p_level_number,
    'configGradeLevel', v_cfg.grade_level
  );

  insert into public.assessment_templates (
    teacher_id, subject_id, grade_level, title, mode, status, settings
  ) values (
    p_teacher_id, p_subject_id, p_grade_level, v_title, p_mode, 'draft', v_settings
  ) returning id into v_template_id;

  -- Unordered unique pairs (a,b) with a <= b in [min_factor, max_factor], shuffled.
  create temporary table if not exists _g9_pairs (
    a smallint not null,
    b smallint not null,
    ord double precision not null
  ) on commit drop;
  delete from _g9_pairs;

  insert into _g9_pairs (a, b, ord)
  select x.a, x.b, random()
  from (
    select least(i, j) as a, greatest(i, j) as b
    from generate_series(v_cfg.min_factor::integer, v_cfg.max_factor::integer) as i
    cross join generate_series(v_cfg.min_factor::integer, v_cfg.max_factor::integer) as j
    group by 1, 2
  ) x;

  select count(*)::integer into v_have from _g9_pairs;
  v_need := v_cfg.question_count;

  -- Squares 11×11 and 12×12 only when unique pairs are fewer than questionCount.
  if v_have < v_need then
    insert into _g9_pairs (a, b, ord)
    select s.a, s.b, random()
    from (values (11, 11), (12, 12)) as s(a, b)
    where not exists (
      select 1 from _g9_pairs p where p.a = s.a and p.b = s.b
    );
  end if;

  for v_pair in
    select p.a, p.b from _g9_pairs p order by p.ord limit v_need
  loop
    v_pos := v_pos + 1;
    -- Present factors in random order for the prompt (pair identity already unique).
    if random() < 0.5 then
      v_a := v_pair.a; v_b := v_pair.b;
    else
      v_a := v_pair.b; v_b := v_pair.a;
    end if;

    v_qid := private.save_question_with_key(
      v_template_id,
      p_teacher_id,
      null,
      v_pos,
      'numeric'::public.question_type,
      jsonb_build_object('text', format('%s × %s = ?', v_a, v_b)),
      '[]'::jsonb,
      1,
      v_cfg.seconds_per_question,
      jsonb_build_object(
        'type', 'numeric',
        'value', (v_a * v_b),
        'tolerance', 0
      )
    );
  end loop;

  return jsonb_build_object(
    'templateId', v_template_id,
    'title', v_title,
    'questionCount', v_pos,
    'configGradeLevel', v_cfg.grade_level,
    'settings', jsonb_build_object(
      'passPercent', v_cfg.pass_percent,
      'maxErrors', v_cfg.max_errors
    )
  );
end;
$$;

revoke all on function public.api_generate_multiplication_test(
  uuid, uuid, integer, integer, public.assessment_mode, text
) from public, anon, authenticated;
grant execute on function public.api_generate_multiplication_test(
  uuid, uuid, integer, integer, public.assessment_mode, text
) to service_role;

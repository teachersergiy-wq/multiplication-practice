-- G9b: hotfix for api_generate_multiplication_test.
-- The API role runs with pg_safeupdate, which rejects a row-removal statement without a
-- WHERE clause (the old function cleared its temporary table that way, so the Edge function
-- returned HTTP 500). The function now builds the pair set in a CTE: no temporary table and
-- no row-removal statement. Behaviour is unchanged.
-- NOT applied to production by agents.

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

  -- Unique unordered pairs (a <= b) in [min_factor, max_factor]; squares 11x11 and 12x12
  -- are added only when the unique pairs are fewer than question_count.
  -- No temporary table: Supabase API requests run with pg_safeupdate, which rejects
  -- unqualified row-removal statements.
  v_have := ((v_cfg.max_factor::integer - v_cfg.min_factor::integer + 1)
           * (v_cfg.max_factor::integer - v_cfg.min_factor::integer + 2)) / 2;
  v_need := v_cfg.question_count;

  for v_pair in
    with base as (
      select least(i, j) as a, greatest(i, j) as b
      from generate_series(v_cfg.min_factor::integer, v_cfg.max_factor::integer) as i
      cross join generate_series(v_cfg.min_factor::integer, v_cfg.max_factor::integer) as j
      group by 1, 2
    ), extra as (
      select s.a, s.b
      from (values (11, 11), (12, 12)) as s(a, b)
      where v_have < v_need
        and not exists (select 1 from base b where b.a = s.a and b.b = s.b)
    ), allp as (
      select a, b from base
      union all
      select a, b from extra
    )
    select a, b from allp order by random() limit v_need
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

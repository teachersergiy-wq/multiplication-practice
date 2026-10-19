-- G3: public service_role wrappers for question editor (keys stay private).
-- NOT applied to production by agents.

create or replace function public.api_save_question_with_key(
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
begin
  -- Defense in depth: answer_key.type must match question_type
  if p_answer_key is null or jsonb_typeof(p_answer_key) <> 'object' then
    raise exception 'invalid_request: answer_key required';
  end if;
  if (p_answer_key->>'type') is distinct from p_question_type::text then
    raise exception 'invalid_request: answer_key type mismatch';
  end if;

  return private.save_question_with_key(
    p_template_id,
    p_question_id,
    p_position,
    p_question_type,
    p_prompt,
    p_choices,
    p_points,
    p_time_limit_seconds,
    p_answer_key
  );
end;
$$;

revoke all on function public.api_save_question_with_key(
  uuid, uuid, integer, public.question_type, jsonb, jsonb, numeric, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.api_save_question_with_key(
  uuid, uuid, integer, public.question_type, jsonb, jsonb, numeric, integer, jsonb
) to service_role;

-- Teacher draft readback including private keys (service_role only).
create or replace function public.api_get_assessment_draft(p_template_id uuid, p_teacher_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_tpl public.assessment_templates%rowtype;
  v_questions jsonb := '[]'::jsonb;
  r record;
  v_key jsonb;
  v_authored jsonb;
begin
  select * into v_tpl
  from public.assessment_templates t
  where t.id = p_template_id and t.teacher_id = p_teacher_id;

  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  for r in
    select q.id, q.position, q.question_type, q.prompt, q.choices, q.points, q.time_limit_seconds
    from public.assessment_questions q
    where q.template_id = p_template_id
    order by q.position
  loop
    select k.answer_key into v_key
    from private.assessment_answer_keys k
    where k.question_id = r.id;

    v_authored := jsonb_build_object(
      'id', r.id,
      'position', r.position,
      'type', r.question_type,
      'promptText', coalesce(r.prompt->>'text', ''),
      'points', r.points,
      'timeLimitSeconds', r.time_limit_seconds,
      'prompt', r.prompt,
      'choices', r.choices,
      'answerKey', v_key
    );
    v_questions := v_questions || jsonb_build_array(v_authored);
  end loop;

  return jsonb_build_object(
    'template', jsonb_build_object(
      'id', v_tpl.id,
      'title', v_tpl.title,
      'subjectId', v_tpl.subject_id,
      'gradeLevel', v_tpl.grade_level,
      'mode', v_tpl.mode,
      'status', v_tpl.status,
      'settings', v_tpl.settings
    ),
    'questions', v_questions
  );
end;
$$;

revoke all on function public.api_get_assessment_draft(uuid, uuid) from public, anon, authenticated;
grant execute on function public.api_get_assessment_draft(uuid, uuid) to service_role;

create or replace function public.api_delete_question(p_question_id uuid, p_teacher_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_template_id uuid;
  v_status public.assessment_status;
begin
  select q.template_id, t.status
    into v_template_id, v_status
  from public.assessment_questions q
  join public.assessment_templates t on t.id = q.template_id
  where q.id = p_question_id and t.teacher_id = p_teacher_id;

  if v_template_id is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_status is distinct from 'draft' then
    raise exception 'conflict: template not draft' using errcode = 'P0001';
  end if;

  delete from public.assessment_questions where id = p_question_id;
  -- Re-pack positions
  with ordered as (
    select id, row_number() over (order by position) as new_pos
    from public.assessment_questions
    where template_id = v_template_id
  )
  update public.assessment_questions q
    set position = ordered.new_pos
  from ordered
  where q.id = ordered.id;

  return true;
end;
$$;

revoke all on function public.api_delete_question(uuid, uuid) from public, anon, authenticated;
grant execute on function public.api_delete_question(uuid, uuid) to service_role;

create or replace function public.api_reorder_questions(
  p_template_id uuid,
  p_teacher_id uuid,
  p_ordered_ids uuid[]
)
returns boolean
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_status public.assessment_status;
  v_count integer;
  v_owner uuid;
begin
  select teacher_id, status into v_owner, v_status
  from public.assessment_templates
  where id = p_template_id;

  if v_owner is null or v_owner is distinct from p_teacher_id then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_status is distinct from 'draft' then
    raise exception 'conflict: template not draft' using errcode = 'P0001';
  end if;

  select count(*) into v_count
  from public.assessment_questions
  where template_id = p_template_id;

  if v_count <> coalesce(array_length(p_ordered_ids, 1), 0) then
    raise exception 'invalid_request: orderedQuestionIds must list every question once';
  end if;

  if (
    select count(distinct x) from unnest(p_ordered_ids) as x
  ) <> v_count then
    raise exception 'invalid_request: duplicate question ids';
  end if;

  if exists (
    select 1
    from unnest(p_ordered_ids) as oid
    left join public.assessment_questions q on q.id = oid and q.template_id = p_template_id
    where q.id is null
  ) then
    raise exception 'invalid_request: unknown question id';
  end if;

  -- Two-phase update to avoid unique (template_id, position) conflicts
  update public.assessment_questions
    set position = position + 100000
  where template_id = p_template_id;

  update public.assessment_questions q
    set position = s.ord
  from unnest(p_ordered_ids) with ordinality as s(id, ord)
  where q.id = s.id and q.template_id = p_template_id;

  return true;
end;
$$;

revoke all on function public.api_reorder_questions(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.api_reorder_questions(uuid, uuid, uuid[]) to service_role;

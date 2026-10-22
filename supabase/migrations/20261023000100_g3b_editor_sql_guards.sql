-- G3b (issue #42): SQL owner/draft guards on save; safe delete repack; key id checks at publish.
-- NOT applied to production by agents.

-- private.save_question_with_key: require teacher ownership + draft template
create or replace function private.save_question_with_key(
  p_template_id uuid,
  p_teacher_id uuid,
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
  v_owner uuid;
  v_status public.assessment_status;
begin
  if p_answer_key is null then
    raise exception 'answer_key required';
  end if;

  select teacher_id, status into v_owner, v_status
  from public.assessment_templates
  where id = p_template_id;

  if v_owner is null or v_owner is distinct from p_teacher_id then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_status is distinct from 'draft' then
    raise exception 'conflict: template not draft' using errcode = 'P0001';
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
      raise exception 'not_found' using errcode = 'P0001';
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

revoke all on function private.save_question_with_key(
  uuid, uuid, uuid, integer, public.question_type, jsonb, jsonb, numeric, integer, jsonb
) from public, anon, authenticated;
grant execute on function private.save_question_with_key(
  uuid, uuid, uuid, integer, public.question_type, jsonb, jsonb, numeric, integer, jsonb
) to service_role;

-- Drop old 9-arg private signature if still present
drop function if exists private.save_question_with_key(
  uuid, uuid, integer, public.question_type, jsonb, jsonb, numeric, integer, jsonb
);

-- public.api_save_question_with_key: add p_teacher_id; drop old signature
drop function if exists public.api_save_question_with_key(
  uuid, uuid, integer, public.question_type, jsonb, jsonb, numeric, integer, jsonb
);

create or replace function public.api_save_question_with_key(
  p_template_id uuid,
  p_teacher_id uuid,
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
  if p_answer_key is null or jsonb_typeof(p_answer_key) <> 'object' then
    raise exception 'invalid_request: answer_key required';
  end if;
  if (p_answer_key->>'type') is distinct from p_question_type::text then
    raise exception 'invalid_request: answer_key type mismatch';
  end if;

  return private.save_question_with_key(
    p_template_id,
    p_teacher_id,
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
  uuid, uuid, uuid, integer, public.question_type, jsonb, jsonb, numeric, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.api_save_question_with_key(
  uuid, uuid, uuid, integer, public.question_type, jsonb, jsonb, numeric, integer, jsonb
) to service_role;

-- api_delete_question: two-phase position repack (avoid unique(template_id, position) mid-update)
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

  -- Phase 1: shift positions out of the unique range
  update public.assessment_questions
    set position = position + 100000
  where template_id = v_template_id;

  -- Phase 2: dense 1..n order by previous position
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

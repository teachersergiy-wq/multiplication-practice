-- G3b (issue #42): SQL owner/draft guards on save; safe delete repack;
-- row lock on assessment_templates so publish cannot race edit/delete/reorder.
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
  where id = p_template_id
  for update;

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

drop function if exists private.save_question_with_key(
  uuid, uuid, integer, public.question_type, jsonb, jsonb, numeric, integer, jsonb
);

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

-- api_delete_question: lock parent template, then two-phase position repack
create or replace function public.api_delete_question(p_question_id uuid, p_teacher_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_template_id uuid;
  v_owner uuid;
  v_status public.assessment_status;
begin
  select q.template_id into v_template_id
  from public.assessment_questions q
  where q.id = p_question_id;

  if v_template_id is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  select teacher_id, status into v_owner, v_status
  from public.assessment_templates
  where id = v_template_id
  for update;

  if v_owner is null or v_owner is distinct from p_teacher_id then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_status is distinct from 'draft' then
    raise exception 'conflict: template not draft' using errcode = 'P0001';
  end if;

  delete from public.assessment_questions where id = p_question_id;

  update public.assessment_questions
    set position = position + 100000
  where template_id = v_template_id;

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

-- api_reorder_questions: lock parent row before rewriting positions
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
  where id = p_template_id
  for update;

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

-- api_publish_assessment: same row lock as editors (keeps G6b integer + choice-id checks)
create or replace function public.api_publish_assessment(
  p_template_id uuid,
  p_teacher_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_owner uuid;
  v_status public.assessment_status;
  v_settings jsonb;
  v_missing uuid[];
  v_qcount integer;
  v_points numeric;
  v_num numeric;
  r record;
  v_choice_ids text[];
  v_key_id text;
  v_key_ids text[];
  v_pair jsonb;
begin
  -- Serialize publish against concurrent edit/delete/reorder (issue #42).
  select teacher_id, status, settings
    into v_owner, v_status, v_settings
  from public.assessment_templates
  where id = p_template_id
  for update;

  if v_owner is null or v_owner is distinct from p_teacher_id then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_status is distinct from 'draft' then
    raise exception 'conflict: template not draft' using errcode = 'P0001';
  end if;

  if v_settings is null or jsonb_typeof(v_settings) <> 'object' then
    raise exception 'incomplete_assessment: invalid settings' using errcode = 'P0001';
  end if;

  if v_settings ? 'passPercent' then
    if jsonb_typeof(v_settings->'passPercent') <> 'number'
       or (v_settings->>'passPercent')::numeric < 1
       or (v_settings->>'passPercent')::numeric > 100 then
      raise exception 'incomplete_assessment: invalid passPercent' using errcode = 'P0001';
    end if;
  end if;
  if v_settings ? 'maxErrors' then
    if jsonb_typeof(v_settings->'maxErrors') <> 'number' then
      raise exception 'incomplete_assessment: invalid maxErrors' using errcode = 'P0001';
    end if;
    v_num := (v_settings->>'maxErrors')::numeric;
    if v_num < 0 or v_num <> trunc(v_num) then
      raise exception 'incomplete_assessment: maxErrors must be non-negative integer' using errcode = 'P0001';
    end if;
  end if;
  if v_settings ? 'totalTimeSeconds' then
    if jsonb_typeof(v_settings->'totalTimeSeconds') <> 'number' then
      raise exception 'incomplete_assessment: invalid totalTimeSeconds' using errcode = 'P0001';
    end if;
    v_num := (v_settings->>'totalTimeSeconds')::numeric;
    if v_num < 1 or v_num > 3600 or v_num <> trunc(v_num) then
      raise exception 'incomplete_assessment: totalTimeSeconds must be integer 1..3600' using errcode = 'P0001';
    end if;
  end if;

  select count(*), coalesce(sum(points), 0)
    into v_qcount, v_points
  from public.assessment_questions
  where template_id = p_template_id;

  if v_qcount < 1 then
    raise exception 'incomplete_assessment: no questions' using errcode = 'P0001';
  end if;

  select array_agg(q.id)
    into v_missing
  from public.assessment_questions q
  left join private.assessment_answer_keys k on k.question_id = q.id
  where q.template_id = p_template_id
    and (
      k.question_id is null
      or k.answer_key is null
      or (k.answer_key->>'type') is distinct from q.question_type::text
      or q.points is null
      or q.points <= 0
    );

  if v_missing is not null and array_length(v_missing, 1) > 0 then
    raise exception 'incomplete_assessment: bad questions %',
      array_to_string(v_missing, ',')
      using errcode = 'P0001';
  end if;

  -- choiceId / pairs must reference existing choices (defense in depth)
  for r in
    select q.id, q.question_type, q.choices, k.answer_key
    from public.assessment_questions q
    join private.assessment_answer_keys k on k.question_id = q.id
    where q.template_id = p_template_id
  loop
    if r.question_type = 'single_choice' then
      select coalesce(array_agg(c->>'id'), '{}') into v_choice_ids
      from jsonb_array_elements(coalesce(r.choices, '[]'::jsonb)) c;
      v_key_id := r.answer_key->>'choiceId';
      if v_key_id is null or not (v_key_id = any (v_choice_ids)) then
        raise exception 'incomplete_assessment: choiceId not in choices for %', r.id
          using errcode = 'P0001';
      end if;
    elsif r.question_type = 'multiple_choice' then
      select coalesce(array_agg(c->>'id'), '{}') into v_choice_ids
      from jsonb_array_elements(coalesce(r.choices, '[]'::jsonb)) c;
      select coalesce(array_agg(x), '{}') into v_key_ids
      from jsonb_array_elements_text(coalesce(r.answer_key->'choiceIds', '[]'::jsonb)) x;
      if cardinality(v_key_ids) < 1 then
        raise exception 'incomplete_assessment: empty choiceIds for %', r.id using errcode = 'P0001';
      end if;
      foreach v_key_id in array v_key_ids loop
        if not (v_key_id = any (v_choice_ids)) then
          raise exception 'incomplete_assessment: choiceId not in choices for %', r.id
            using errcode = 'P0001';
        end if;
      end loop;
    elsif r.question_type = 'ordering' then
      select coalesce(array_agg(c->>'id'), '{}') into v_choice_ids
      from jsonb_array_elements(coalesce(r.choices, '[]'::jsonb)) c;
      select coalesce(array_agg(x), '{}') into v_key_ids
      from jsonb_array_elements_text(coalesce(r.answer_key->'order', '[]'::jsonb)) x;
      if cardinality(v_key_ids) is distinct from cardinality(v_choice_ids) then
        raise exception 'incomplete_assessment: order length mismatch for %', r.id
          using errcode = 'P0001';
      end if;
      foreach v_key_id in array v_key_ids loop
        if not (v_key_id = any (v_choice_ids)) then
          raise exception 'incomplete_assessment: order id not in choices for %', r.id
            using errcode = 'P0001';
        end if;
      end loop;
    elsif r.question_type = 'matching' then
      select coalesce(array_agg(c->>'id'), '{}') into v_choice_ids
      from jsonb_array_elements(coalesce(r.choices, '[]'::jsonb)) c;
      for v_pair in
        select value from jsonb_array_elements(coalesce(r.answer_key->'pairs', '[]'::jsonb)) as t(value)
      loop
        if not ((v_pair->>'leftId') = any (v_choice_ids))
           or not ((v_pair->>'rightId') = any (v_choice_ids)) then
          raise exception 'incomplete_assessment: pair ids not in items for %', r.id
            using errcode = 'P0001';
        end if;
      end loop;
    end if;
  end loop;

  update public.assessment_templates
    set status = 'published', updated_at = now()
  where id = p_template_id and status = 'draft';

  if not found then
    raise exception 'conflict: template not draft' using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'templateId', p_template_id,
    'status', 'published',
    'questionCount', v_qcount,
    'totalPoints', v_points
  );
end;
$$;



revoke all on function public.api_publish_assessment(uuid, uuid) from public, anon, authenticated;
grant execute on function public.api_publish_assessment(uuid, uuid) to service_role;

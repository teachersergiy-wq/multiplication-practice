-- G6b: review fixes (issue #36). Avoid DROP of finalize_attempt signature.
-- NOT applied to production by agents.

-- Score in-progress attempt and mark abandoned (keeps finalize_attempt(uuid) intact).
create or replace function private.abandon_attempt(p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_result jsonb;
  v_status public.attempt_status;
begin
  select status into v_status from public.assessment_attempts where id = p_attempt_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_status is distinct from 'in_progress' then
    return private.finalize_attempt(p_attempt_id);
  end if;

  -- Score then force status to abandoned (finalize sets completed; we override).
  v_result := private.finalize_attempt(p_attempt_id);
  update public.assessment_attempts
    set status = 'abandoned'
  where id = p_attempt_id and status = 'completed';
  return jsonb_set(v_result, '{status}', '"abandoned"');
end;
$$;

revoke all on function private.abandon_attempt(uuid) from public, anon, authenticated;
grant execute on function private.abandon_attempt(uuid) to service_role;

create or replace function public.api_submit_answer(
  p_attempt_id uuid,
  p_student_id uuid,
  p_question_id uuid,
  p_response jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_attempt public.assessment_attempts%rowtype;
  v_mode public.assessment_mode;
  v_template_id uuid;
  v_q public.assessment_questions%rowtype;
  v_key jsonb;
  v_correct boolean;
  v_pts numeric;
  v_deadline timestamptz;
  v_limit_sec integer;
  v_settings jsonb;
  v_all_have boolean;
  v_sum integer;
  v_type text;
  v_arr jsonb;
  v_len integer;
  v_text text;
  v_num numeric;
begin
  select * into v_attempt from public.assessment_attempts where id = p_attempt_id for update;
  if not found or v_attempt.student_id is distinct from p_student_id then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_attempt.status is distinct from 'in_progress' then
    raise exception 'attempt_not_in_progress' using errcode = 'P0001';
  end if;

  select t.mode, t.id, t.settings into v_mode, v_template_id, v_settings
  from public.assessment_assignments a
  join public.assessment_templates t on t.id = a.template_id
  where a.id = v_attempt.assignment_id;

  v_limit_sec := null;
  if v_settings ? 'totalTimeSeconds' then
    v_num := (v_settings->>'totalTimeSeconds')::numeric;
    v_limit_sec := trunc(v_num)::integer;
  else
    select bool_and(time_limit_seconds is not null), coalesce(sum(time_limit_seconds), 0)
      into v_all_have, v_sum
    from public.assessment_questions where template_id = v_template_id;
    if v_all_have and v_sum > 0 then v_limit_sec := v_sum; end if;
  end if;
  if v_limit_sec is not null then
    v_deadline := v_attempt.started_at + make_interval(secs => v_limit_sec + 15);
    if v_deadline <= now() then
      perform private.abandon_attempt(p_attempt_id);
      return jsonb_build_object('expired', true, 'accepted', false);
    end if;
  end if;

  select * into v_q from public.assessment_questions
  where id = p_question_id and template_id = v_template_id;
  if not found then
    raise exception 'invalid_request: question not in assessment' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.assessment_responses
    where attempt_id = p_attempt_id and question_id = p_question_id
  ) then
    raise exception 'already_answered' using errcode = 'P0001';
  end if;

  if p_response is null or jsonb_typeof(p_response) <> 'object' then
    raise exception 'invalid_request: response must be object' using errcode = 'P0001';
  end if;

  v_type := p_response->>'type';
  if v_type is distinct from v_q.question_type::text then
    raise exception 'invalid_request: response type mismatch' using errcode = 'P0001';
  end if;

  if v_type = 'true_false' then
    if jsonb_typeof(p_response->'value') <> 'boolean' then
      raise exception 'invalid_request: true_false value must be boolean' using errcode = 'P0001';
    end if;
  elsif v_type = 'single_choice' then
    if jsonb_typeof(p_response->'choiceId') <> 'string'
       or length(coalesce(p_response->>'choiceId', '')) < 1
       or length(p_response->>'choiceId') > 64 then
      raise exception 'invalid_request: single_choice choiceId' using errcode = 'P0001';
    end if;
  elsif v_type = 'multiple_choice' then
    v_arr := coalesce(p_response->'choiceIds', '[]'::jsonb);
    if jsonb_typeof(v_arr) <> 'array' then
      raise exception 'invalid_request: multiple_choice choiceIds' using errcode = 'P0001';
    end if;
    v_len := jsonb_array_length(v_arr);
    if v_len < 1 or v_len > 8 then
      raise exception 'invalid_request: multiple_choice choiceIds length' using errcode = 'P0001';
    end if;
  elsif v_type = 'ordering' then
    v_arr := coalesce(p_response->'order', '[]'::jsonb);
    if jsonb_typeof(v_arr) <> 'array' then
      raise exception 'invalid_request: ordering order' using errcode = 'P0001';
    end if;
    v_len := jsonb_array_length(v_arr);
    if v_len < 1 or v_len > 8 then
      raise exception 'invalid_request: ordering order length' using errcode = 'P0001';
    end if;
  elsif v_type = 'matching' then
    v_arr := coalesce(p_response->'pairs', '[]'::jsonb);
    if jsonb_typeof(v_arr) <> 'array' then
      raise exception 'invalid_request: matching pairs' using errcode = 'P0001';
    end if;
    v_len := jsonb_array_length(v_arr);
    if v_len < 1 or v_len > 8 then
      raise exception 'invalid_request: matching pairs length' using errcode = 'P0001';
    end if;
  elsif v_type = 'numeric' then
    v_text := coalesce(p_response->>'text', '');
    if length(v_text) < 1 or length(v_text) > 64 then
      raise exception 'invalid_request: numeric text length' using errcode = 'P0001';
    end if;
  elsif v_type = 'short_answer' then
    v_text := coalesce(p_response->>'text', '');
    if length(v_text) < 1 or length(v_text) > 200 then
      raise exception 'invalid_request: short_answer text length' using errcode = 'P0001';
    end if;
  else
    raise exception 'invalid_request: unknown response type' using errcode = 'P0001';
  end if;

  select answer_key into v_key from private.assessment_answer_keys where question_id = p_question_id;

  if v_mode = 'practice' then
    select s.is_correct, s.awarded_points into v_correct, v_pts
    from private.score_response(v_q.question_type, v_key, p_response, v_q.points) s;
    insert into public.assessment_responses (attempt_id, question_id, response, is_correct, awarded_points)
    values (p_attempt_id, p_question_id, p_response, v_correct, v_pts);
    return jsonb_build_object(
      'accepted', true,
      'feedback', jsonb_build_object('isCorrect', v_correct, 'awardedPoints', v_pts)
    );
  else
    insert into public.assessment_responses (attempt_id, question_id, response, is_correct, awarded_points)
    values (p_attempt_id, p_question_id, p_response, null, null);
    return jsonb_build_object('accepted', true);
  end if;
end;
$$;

revoke all on function public.api_submit_answer(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.api_submit_answer(uuid, uuid, uuid, jsonb) to service_role;

-- Concurrent start + expire existing via abandon
create or replace function public.api_start_attempt(
  p_assignment_id uuid,
  p_student_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_asg public.assessment_assignments%rowtype;
  v_tpl public.assessment_templates%rowtype;
  v_existing public.assessment_attempts%rowtype;
  v_attempt_id uuid;
  v_resumed boolean := false;
  v_deadline timestamptz;
  v_limit_sec integer;
  v_sum_q integer;
  v_all_have_limit boolean;
  v_questions jsonb := '[]'::jsonb;
  v_answered uuid[] := '{}';
  r record;
  v_pub jsonb;
  v_num numeric;
begin
  if not exists (
    select 1 from public.profiles p where p.id = p_student_id and p.role = 'student'
  ) then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;

  select * into v_asg from public.assessment_assignments where id = p_assignment_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.class_students cs
    where cs.student_id = p_student_id and cs.class_id = v_asg.class_id
  ) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  if v_asg.opens_at is not null and v_asg.opens_at > now() then
    raise exception 'assignment_not_open' using errcode = 'P0001';
  end if;
  if v_asg.closes_at is not null and v_asg.closes_at <= now() then
    raise exception 'assignment_closed' using errcode = 'P0001';
  end if;

  select * into v_tpl from public.assessment_templates where id = v_asg.template_id;
  if v_tpl.status is distinct from 'published' then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  select * into v_existing
  from public.assessment_attempts
  where assignment_id = p_assignment_id and student_id = p_student_id and status = 'in_progress'
  for update;

  if found then
    v_limit_sec := null;
    if v_tpl.settings ? 'totalTimeSeconds' then
      v_num := (v_tpl.settings->>'totalTimeSeconds')::numeric;
      v_limit_sec := trunc(v_num)::integer;
    else
      select bool_and(time_limit_seconds is not null), coalesce(sum(time_limit_seconds), 0)
        into v_all_have_limit, v_sum_q
      from public.assessment_questions where template_id = v_tpl.id;
      if v_all_have_limit and v_sum_q > 0 then
        v_limit_sec := v_sum_q;
      end if;
    end if;
    if v_limit_sec is not null then
      v_deadline := v_existing.started_at + make_interval(secs => v_limit_sec + 15);
      if v_deadline <= now() then
        perform private.abandon_attempt(v_existing.id);
      else
        v_attempt_id := v_existing.id;
        v_resumed := true;
      end if;
    else
      v_attempt_id := v_existing.id;
      v_resumed := true;
      v_deadline := null;
    end if;
  end if;

  if v_attempt_id is null then
    if not v_asg.allow_retries then
      if exists (
        select 1 from public.assessment_attempts
        where assignment_id = p_assignment_id and student_id = p_student_id
          and status in ('completed', 'abandoned')
      ) then
        raise exception 'retry_not_allowed' using errcode = 'P0001';
      end if;
    end if;

    begin
      insert into public.assessment_attempts (assignment_id, student_id, status, started_at)
      values (p_assignment_id, p_student_id, 'in_progress', now())
      returning id into v_attempt_id;
    exception
      when unique_violation then
        select * into v_existing
        from public.assessment_attempts
        where assignment_id = p_assignment_id
          and student_id = p_student_id
          and status = 'in_progress'
        for update;
        if not found then
          raise exception 'internal: concurrent start lost race' using errcode = 'P0001';
        end if;
        v_attempt_id := v_existing.id;
        v_resumed := true;
    end;

    v_limit_sec := null;
    if v_tpl.settings ? 'totalTimeSeconds' then
      v_num := (v_tpl.settings->>'totalTimeSeconds')::numeric;
      v_limit_sec := trunc(v_num)::integer;
    else
      select bool_and(time_limit_seconds is not null), coalesce(sum(time_limit_seconds), 0)
        into v_all_have_limit, v_sum_q
      from public.assessment_questions where template_id = v_tpl.id;
      if v_all_have_limit and v_sum_q > 0 then v_limit_sec := v_sum_q; end if;
    end if;
    if v_limit_sec is not null then
      v_deadline := now() + make_interval(secs => v_limit_sec + 15);
    end if;
  end if;

  select * into v_existing from public.assessment_attempts where id = v_attempt_id;

  for r in
    select q.id, q.position, q.question_type, q.prompt, q.choices, q.points, q.time_limit_seconds
    from public.assessment_questions q
    where q.template_id = v_tpl.id
    order by q.position
  loop
    v_pub := jsonb_build_object(
      'id', r.id,
      'position', r.position,
      'type', r.question_type,
      'promptText', coalesce(r.prompt->>'text', ''),
      'points', r.points,
      'timeLimitSeconds', r.time_limit_seconds
    );
    if r.question_type in ('single_choice', 'multiple_choice', 'ordering') then
      v_pub := v_pub || jsonb_build_object('choices', coalesce(r.choices, '[]'::jsonb));
    elsif r.question_type = 'matching' then
      v_pub := v_pub || jsonb_build_object('items', coalesce(r.choices, '[]'::jsonb));
    end if;
    v_questions := v_questions || jsonb_build_array(v_pub);
  end loop;

  select coalesce(array_agg(question_id), '{}') into v_answered
  from public.assessment_responses where attempt_id = v_attempt_id;

  return jsonb_build_object(
    'attemptId', v_attempt_id,
    'resumed', v_resumed,
    'startedAt', v_existing.started_at,
    'serverNow', now(),
    'deadlineAt', v_deadline,
    'mode', v_tpl.mode,
    'settings', coalesce(v_tpl.settings, '{}'::jsonb),
    'questions', v_questions,
    'answeredQuestionIds', to_jsonb(v_answered)
  );
end;
$$;

revoke all on function public.api_start_attempt(uuid, uuid) from public, anon, authenticated;
grant execute on function public.api_start_attempt(uuid, uuid) to service_role;

-- Integer settings at publish + key id refs
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
  select teacher_id, status, settings
    into v_owner, v_status, v_settings
  from public.assessment_templates
  where id = p_template_id;

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

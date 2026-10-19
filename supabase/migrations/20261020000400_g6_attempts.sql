-- G6: attempt lifecycle + real all-or-nothing scoring (checker_version=1).
-- NOT applied to production by agents.

create or replace function private.score_response(
  p_question_type public.question_type,
  p_answer_key jsonb,
  p_response jsonb,
  p_points numeric
)
returns table(is_correct boolean, awarded_points numeric)
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_ok boolean := false;
  v_resp_type text;
  a text[];
  b text[];
  v_num numeric;
  v_tol numeric;
  v_text text;
  v_acc text;
  v_case boolean;
begin
  if p_answer_key is null or p_response is null then
    return query select false, 0::numeric;
    return;
  end if;
  v_resp_type := p_response->>'type';
  if v_resp_type is distinct from p_question_type::text then
    return query select false, 0::numeric;
    return;
  end if;

  if p_question_type = 'true_false' then
    v_ok := (p_response->'value') = (p_answer_key->'value');

  elsif p_question_type = 'single_choice' then
    v_ok := (p_response->>'choiceId') is not distinct from (p_answer_key->>'choiceId');

  elsif p_question_type = 'multiple_choice' then
    select array_agg(x order by x) into a
    from jsonb_array_elements_text(coalesce(p_response->'choiceIds', '[]'::jsonb)) as x;
    select array_agg(x order by x) into b
    from jsonb_array_elements_text(coalesce(p_answer_key->'choiceIds', '[]'::jsonb)) as x;
    v_ok := a is not distinct from b;

  elsif p_question_type = 'ordering' then
    select array_agg(x order by ordinality) into a
    from jsonb_array_elements_text(coalesce(p_response->'order', '[]'::jsonb)) with ordinality as t(x, ordinality);
    select array_agg(x order by ordinality) into b
    from jsonb_array_elements_text(coalesce(p_answer_key->'order', '[]'::jsonb)) with ordinality as t(x, ordinality);
    v_ok := a is not distinct from b;

  elsif p_question_type = 'matching' then
    v_ok := not exists (
      select 1
      from jsonb_array_elements(coalesce(p_answer_key->'pairs', '[]'::jsonb)) kp
      where not exists (
        select 1
        from jsonb_array_elements(coalesce(p_response->'pairs', '[]'::jsonb)) rp
        where rp->>'leftId' = kp->>'leftId'
          and rp->>'rightId' = kp->>'rightId'
      )
    )
    and jsonb_array_length(coalesce(p_response->'pairs', '[]'::jsonb))
        = jsonb_array_length(coalesce(p_answer_key->'pairs', '[]'::jsonb));

  elsif p_question_type = 'numeric' then
    v_text := replace(trim(coalesce(p_response->>'text', '')), ',', '.');
    if v_text ~ '^[+-]?\d+([.]\d+)?$' then
      v_num := v_text::numeric;
      v_tol := coalesce((p_answer_key->>'tolerance')::numeric, 0) + 1e-9;
      v_ok := abs(v_num - (p_answer_key->>'value')::numeric) <= v_tol;
    else
      v_ok := false;
    end if;

  elsif p_question_type = 'short_answer' then
    v_text := trim(coalesce(p_response->>'text', ''));
    v_case := coalesce((p_answer_key->>'caseSensitive')::boolean, false);
    if not v_case then
      v_text := lower(v_text);
    end if;
    v_text := regexp_replace(v_text, '\s+', ' ', 'g');
    v_ok := false;
    for v_acc in
      select jsonb_array_elements_text(coalesce(p_answer_key->'accepted', '[]'::jsonb))
    loop
      v_acc := trim(v_acc);
      if not v_case then v_acc := lower(v_acc); end if;
      v_acc := regexp_replace(v_acc, '\s+', ' ', 'g');
      if v_acc = v_text then
        v_ok := true;
        exit;
      end if;
    end loop;
  end if;

  return query select v_ok, case when v_ok then coalesce(p_points, 0) else 0::numeric end;
end;
$$;

revoke all on function private.score_response(public.question_type, jsonb, jsonb, numeric) from public, anon, authenticated;
grant execute on function private.score_response(public.question_type, jsonb, jsonb, numeric) to service_role;

-- Previous stub returned void; must drop before changing return type to jsonb.
drop function if exists private.finalize_attempt(uuid);

create function private.finalize_attempt(p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_attempt public.assessment_attempts%rowtype;
  v_mode public.assessment_mode;
  v_settings jsonb;
  v_template_id uuid;
  r record;
  v_score numeric := 0;
  v_max numeric := 0;
  v_mistakes integer := 0;
  v_qcount integer := 0;
  v_answered integer := 0;
  v_correct boolean;
  v_pts numeric;
  v_pass boolean;
  v_percent numeric;
  v_elapsed integer;
  v_has_pass_pct boolean;
  v_has_max_err boolean;
  v_pass_ok boolean := true;
begin
  select * into v_attempt from public.assessment_attempts where id = p_attempt_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  if v_attempt.status <> 'in_progress' then
    v_percent := case when coalesce(v_attempt.max_score, 0) > 0
      then round((v_attempt.score / v_attempt.max_score) * 100, 2) else 0 end;
    return jsonb_build_object(
      'attemptId', v_attempt.id,
      'status', v_attempt.status,
      'score', coalesce(v_attempt.score, 0),
      'maxScore', coalesce(v_attempt.max_score, 0),
      'percent', v_percent,
      'passed', v_attempt.passed,
      'mistakes', null,
      'questionCount', null,
      'answeredCount', null,
      'elapsedMs', coalesce(v_attempt.elapsed_ms, 0)
    );
  end if;

  select t.mode, t.settings, t.id
    into v_mode, v_settings, v_template_id
  from public.assessment_assignments a
  join public.assessment_templates t on t.id = a.template_id
  where a.id = v_attempt.assignment_id;

  for r in
    select q.id, q.question_type, q.points, k.answer_key, resp.response, resp.id as response_id
    from public.assessment_questions q
    left join private.assessment_answer_keys k on k.question_id = q.id
    left join public.assessment_responses resp
      on resp.question_id = q.id and resp.attempt_id = p_attempt_id
    where q.template_id = v_template_id
    order by q.position
  loop
    v_qcount := v_qcount + 1;
    v_max := v_max + coalesce(r.points, 0);

    if r.response is null then
      v_mistakes := v_mistakes + 1;
      continue;
    end if;
    v_answered := v_answered + 1;

    select s.is_correct, s.awarded_points
      into v_correct, v_pts
    from private.score_response(r.question_type, r.answer_key, r.response, r.points) s;

    if not coalesce(v_correct, false) then
      v_mistakes := v_mistakes + 1;
    end if;
    v_score := v_score + coalesce(v_pts, 0);

    update public.assessment_responses
      set is_correct = v_correct,
          awarded_points = v_pts
    where id = r.response_id;
  end loop;

  v_elapsed := greatest(0, (extract(epoch from (now() - v_attempt.started_at)) * 1000)::integer);
  v_percent := case when v_max > 0 then round((v_score / v_max) * 100, 2) else 0 end;

  v_has_pass_pct := v_settings ? 'passPercent';
  v_has_max_err := v_settings ? 'maxErrors';
  if v_has_pass_pct then
    v_pass_ok := v_pass_ok and (v_percent >= (v_settings->>'passPercent')::numeric);
  end if;
  if v_has_max_err then
    v_pass_ok := v_pass_ok and (v_mistakes <= (v_settings->>'maxErrors')::integer);
  end if;
  if v_has_pass_pct or v_has_max_err then
    v_pass := v_pass_ok;
  else
    v_pass := null;
  end if;

  update public.assessment_attempts set
    status = 'completed',
    finished_at = now(),
    score = v_score,
    max_score = v_max,
    passed = v_pass,
    elapsed_ms = v_elapsed
  where id = p_attempt_id;

  return jsonb_build_object(
    'attemptId', p_attempt_id,
    'status', 'completed',
    'score', v_score,
    'maxScore', v_max,
    'percent', v_percent,
    'passed', v_pass,
    'mistakes', v_mistakes,
    'questionCount', v_qcount,
    'answeredCount', v_answered,
    'elapsedMs', v_elapsed
  );
end;
$$;

revoke all on function private.finalize_attempt(uuid) from public, anon, authenticated;
grant execute on function private.finalize_attempt(uuid) to service_role;

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

  if v_mode = 'graded' and v_status = 'in_progress' and TG_OP = 'INSERT' then
    if new.is_correct is not null or new.awarded_points is not null then
      raise exception 'scores forbidden until attempt is finished';
    end if;
  end if;
  return new;
end;
$$;

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
      v_limit_sec := (v_tpl.settings->>'totalTimeSeconds')::integer;
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
        update public.assessment_attempts
          set status = 'abandoned', finished_at = now(),
              elapsed_ms = (extract(epoch from (now() - started_at)) * 1000)::integer
        where id = v_existing.id;
        v_existing := null;
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

    insert into public.assessment_attempts (assignment_id, student_id, status, started_at)
    values (p_assignment_id, p_student_id, 'in_progress', now())
    returning id into v_attempt_id;

    v_limit_sec := null;
    if v_tpl.settings ? 'totalTimeSeconds' then
      v_limit_sec := (v_tpl.settings->>'totalTimeSeconds')::integer;
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
    v_limit_sec := (v_settings->>'totalTimeSeconds')::integer;
  else
    select bool_and(time_limit_seconds is not null), coalesce(sum(time_limit_seconds), 0)
      into v_all_have, v_sum
    from public.assessment_questions where template_id = v_template_id;
    if v_all_have and v_sum > 0 then v_limit_sec := v_sum; end if;
  end if;
  if v_limit_sec is not null then
    v_deadline := v_attempt.started_at + make_interval(secs => v_limit_sec + 15);
    if v_deadline <= now() then
      perform private.finalize_attempt(p_attempt_id);
      update public.assessment_attempts set status = 'abandoned'
        where id = p_attempt_id and status = 'in_progress';
      raise exception 'attempt_expired' using errcode = 'P0001';
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

  if p_response is null or (p_response->>'type') is distinct from v_q.question_type::text then
    raise exception 'invalid_request: response type mismatch' using errcode = 'P0001';
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

create or replace function public.api_finish_attempt(
  p_attempt_id uuid,
  p_student_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_attempt public.assessment_attempts%rowtype;
  v_result jsonb;
begin
  select * into v_attempt from public.assessment_attempts where id = p_attempt_id;
  if not found or v_attempt.student_id is distinct from p_student_id then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  v_result := private.finalize_attempt(p_attempt_id);
  return v_result;
end;
$$;

revoke all on function public.api_finish_attempt(uuid, uuid) from public, anon, authenticated;
grant execute on function public.api_finish_attempt(uuid, uuid) to service_role;

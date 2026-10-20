-- G6b: review fixes for G6/G4 (issue #36). Part 1: finalize + expire path.
-- NOT applied to production by agents.

drop function if exists private.finalize_attempt(uuid);
drop function if exists private.finalize_attempt(uuid, boolean);

create function private.finalize_attempt(
  p_attempt_id uuid,
  p_as_abandoned boolean default false
)
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
  v_final_status public.attempt_status;
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
    v_pass_ok := v_pass_ok and (v_mistakes <= trunc((v_settings->>'maxErrors')::numeric)::integer);
  end if;
  if v_has_pass_pct or v_has_max_err then
    v_pass := v_pass_ok;
  else
    v_pass := null;
  end if;

  if p_as_abandoned then
    v_final_status := 'abandoned';
  else
    v_final_status := 'completed';
  end if;

  update public.assessment_attempts set
    status = v_final_status,
    finished_at = now(),
    score = v_score,
    max_score = v_max,
    passed = v_pass,
    elapsed_ms = v_elapsed
  where id = p_attempt_id;

  return jsonb_build_object(
    'attemptId', p_attempt_id,
    'status', v_final_status,
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

revoke all on function private.finalize_attempt(uuid, boolean) from public, anon, authenticated;
grant execute on function private.finalize_attempt(uuid, boolean) to service_role;

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
begin
  select * into v_attempt from public.assessment_attempts where id = p_attempt_id;
  if not found or v_attempt.student_id is distinct from p_student_id then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  return private.finalize_attempt(p_attempt_id, false);
end;
$$;

revoke all on function public.api_finish_attempt(uuid, uuid) from public, anon, authenticated;
grant execute on function public.api_finish_attempt(uuid, uuid) to service_role;

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
    v_limit_sec := trunc((v_settings->>'totalTimeSeconds')::numeric)::integer;
  else
    select bool_and(time_limit_seconds is not null), coalesce(sum(time_limit_seconds), 0)
      into v_all_have, v_sum
    from public.assessment_questions where template_id = v_template_id;
    if v_all_have and v_sum > 0 then v_limit_sec := v_sum; end if;
  end if;
  if v_limit_sec is not null then
    v_deadline := v_attempt.started_at + make_interval(secs => v_limit_sec + 15);
    if v_deadline <= now() then
      perform private.finalize_attempt(p_attempt_id, true);
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

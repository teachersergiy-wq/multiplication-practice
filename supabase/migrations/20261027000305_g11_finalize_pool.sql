-- G11: finalize_attempt scores only pool sample; out-of-sample submit blocked in start path via membership.
-- Patch submit: reject question not in assessment_attempt_questions for pool templates.

create or replace function private.finalize_attempt(p_attempt_id uuid)
returns jsonb language plpgsql security definer set search_path = public, private, pg_temp as $$
declare
  v_attempt public.assessment_attempts%rowtype;
  v_mode public.assessment_mode; v_settings jsonb; v_template_id uuid;
  rec record; v_score numeric := 0; v_max numeric := 0; v_mistakes int := 0;
  v_qcount int := 0; v_answered int := 0; v_elapsed int; v_percent numeric;
  v_pass boolean; v_pass_ok boolean := true; v_has_pass_pct boolean; v_has_max_err boolean;
  v_correct boolean; v_pts numeric; v_is_pool boolean;
begin
  select * into v_attempt from public.assessment_attempts where id = p_attempt_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0001'; end if;

  select t.mode, t.settings, t.id into v_mode, v_settings, v_template_id
  from public.assessment_assignments a join public.assessment_templates t on t.id = a.template_id
  where a.id = v_attempt.assignment_id;
  v_is_pool := v_settings ? 'pool';

  if v_attempt.status in ('completed', 'expired', 'abandoned') then
    if v_is_pool then
      select count(*)::int into v_qcount from public.assessment_attempt_questions aq where aq.attempt_id = p_attempt_id;
      select count(*)::int into v_answered from public.assessment_responses resp
        join public.assessment_attempt_questions aq on aq.attempt_id = resp.attempt_id and aq.question_id = resp.question_id
        where resp.attempt_id = p_attempt_id;
      select count(*)::int into v_mistakes from public.assessment_attempt_questions aq
        join public.assessment_questions q on q.id = aq.question_id
        left join public.assessment_responses resp on resp.question_id = q.id and resp.attempt_id = p_attempt_id
        where aq.attempt_id = p_attempt_id
          and (resp.id is null or resp.response is null or coalesce(resp.is_correct,false) = false);
    else
      select count(*)::int into v_qcount from public.assessment_questions q where q.template_id = v_template_id;
      select count(*)::int into v_answered from public.assessment_responses resp where resp.attempt_id = p_attempt_id;
      select count(*)::int into v_mistakes from public.assessment_questions q
        left join public.assessment_responses resp on resp.question_id = q.id and resp.attempt_id = p_attempt_id
        where q.template_id = v_template_id
          and (resp.id is null or resp.response is null or coalesce(resp.is_correct,false) = false);
    end if;
    v_percent := case when coalesce(v_attempt.max_score,0) > 0 then round((coalesce(v_attempt.score,0)/v_attempt.max_score)*100,2) else 0 end;
    return jsonb_build_object(
      'attemptId', v_attempt.id, 'status', v_attempt.status,
      'score', coalesce(v_attempt.score,0), 'maxScore', coalesce(v_attempt.max_score,0),
      'percent', v_percent, 'passed', v_attempt.passed,
      'mistakes', coalesce(v_mistakes,0), 'questionCount', coalesce(v_qcount,0),
      'answeredCount', coalesce(v_answered,0), 'elapsedMs', coalesce(v_attempt.elapsed_ms,0)
    );
  end if;

  for rec in
    select q.id, q.question_type, q.points, k.answer_key, resp.response, resp.id as response_id
    from public.assessment_questions q
    left join private.assessment_answer_keys k on k.question_id = q.id
    left join public.assessment_responses resp on resp.question_id = q.id and resp.attempt_id = p_attempt_id
    where q.template_id = v_template_id
      and (not v_is_pool or exists (
        select 1 from public.assessment_attempt_questions aq
        where aq.attempt_id = p_attempt_id and aq.question_id = q.id))
    order by q.position
  loop
    v_qcount := v_qcount + 1;
    v_max := v_max + coalesce(rec.points, 0);
    if rec.response is null then v_mistakes := v_mistakes + 1; continue; end if;
    v_answered := v_answered + 1;
    select s.is_correct, s.awarded_points into v_correct, v_pts
    from private.score_response(rec.question_type, rec.answer_key, rec.response, rec.points) s;
    if not coalesce(v_correct, false) then v_mistakes := v_mistakes + 1; end if;
    v_score := v_score + coalesce(v_pts, 0);
    if rec.response_id is not null then
      update public.assessment_responses set is_correct = v_correct, awarded_points = v_pts where id = rec.response_id;
    end if;
  end loop;

  v_elapsed := greatest(0, (extract(epoch from (now() - v_attempt.started_at)) * 1000)::int);
  v_percent := case when v_max > 0 then round((v_score / v_max) * 100, 2) else 0 end;
  v_has_pass_pct := v_settings ? 'passPercent';
  v_has_max_err := v_settings ? 'maxErrors';
  if v_has_pass_pct then v_pass_ok := v_pass_ok and (v_percent >= (v_settings->>'passPercent')::numeric); end if;
  if v_has_max_err then v_pass_ok := v_pass_ok and (v_mistakes <= (v_settings->>'maxErrors')::int); end if;
  if v_has_pass_pct or v_has_max_err then v_pass := v_pass_ok; else v_pass := null; end if;

  update public.assessment_attempts set
    status = 'completed', finished_at = now(), score = v_score, max_score = v_max,
    passed = v_pass, elapsed_ms = v_elapsed
  where id = p_attempt_id;

  return jsonb_build_object(
    'attemptId', p_attempt_id, 'status', 'completed', 'score', v_score, 'maxScore', v_max,
    'percent', v_percent, 'passed', v_pass, 'mistakes', v_mistakes,
    'questionCount', v_qcount, 'answeredCount', v_answered, 'elapsedMs', v_elapsed
  );
end; $$;
revoke all on function private.finalize_attempt(uuid) from public, anon, authenticated;
grant execute on function private.finalize_attempt(uuid) to service_role;

-- Guard for pool submits (runs before answer insert via replacing api_submit_answer body prefix check).
create or replace function private.assert_question_in_attempt(p_attempt_id uuid, p_question_id uuid)
returns void language plpgsql security definer set search_path = public, private, pg_temp as $$
declare v_settings jsonb;
begin
  select t.settings into v_settings
  from public.assessment_attempts a
  join public.assessment_assignments asg on asg.id = a.assignment_id
  join public.assessment_templates t on t.id = asg.template_id
  where a.id = p_attempt_id;
  if v_settings ? 'pool' then
    if not exists (
      select 1 from public.assessment_attempt_questions aq
      where aq.attempt_id = p_attempt_id and aq.question_id = p_question_id
    ) then
      raise exception 'not_found' using errcode = 'P0001';
    end if;
  end if;
end; $$;
revoke all on function private.assert_question_in_attempt(uuid,uuid) from public, anon, authenticated;
grant execute on function private.assert_question_in_attempt(uuid,uuid) to service_role;

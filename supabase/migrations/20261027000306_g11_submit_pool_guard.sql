-- G11: submit-answer requires question in pool sample
create or replace function public.api_submit_answer(
  p_attempt_id uuid, p_student_id uuid, p_question_id uuid, p_response jsonb
) returns jsonb language plpgsql security definer set search_path = public, private, pg_temp as $$
declare
  v_attempt public.assessment_attempts%rowtype;
  v_mode public.assessment_mode; v_template_id uuid; v_q public.assessment_questions%rowtype;
  v_key jsonb; v_correct boolean; v_pts numeric; v_deadline timestamptz;
  v_limit_sec int; v_settings jsonb; v_all_have boolean; v_sum int;
begin
  select * into v_attempt from public.assessment_attempts where id = p_attempt_id for update;
  if not found or v_attempt.student_id is distinct from p_student_id then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_attempt.status is distinct from 'in_progress' then
    raise exception 'attempt_not_in_progress' using errcode = 'P0001';
  end if;

  perform private.assert_question_in_attempt(p_attempt_id, p_question_id);

  select t.mode, t.id, t.settings into v_mode, v_template_id, v_settings
  from public.assessment_assignments a join public.assessment_templates t on t.id = a.template_id
  where a.id = v_attempt.assignment_id;

  v_limit_sec := null;
  if v_settings ? 'totalTimeSeconds' then
    v_limit_sec := (v_settings->>'totalTimeSeconds')::int;
  else
    if v_settings ? 'pool' then
      select bool_and(q.time_limit_seconds is not null), coalesce(sum(q.time_limit_seconds),0)
        into v_all_have, v_sum
      from public.assessment_attempt_questions aq
      join public.assessment_questions q on q.id = aq.question_id
      where aq.attempt_id = p_attempt_id;
    else
      select bool_and(time_limit_seconds is not null), coalesce(sum(time_limit_seconds),0)
        into v_all_have, v_sum from public.assessment_questions where template_id = v_template_id;
    end if;
    if v_all_have and v_sum > 0 then v_limit_sec := v_sum; end if;
  end if;
  if v_limit_sec is not null then
    v_deadline := v_attempt.started_at + make_interval(secs => v_limit_sec + 15);
    if v_deadline <= now() then
      perform private.finalize_attempt(p_attempt_id);
      update public.assessment_attempts set status = 'abandoned' where id = p_attempt_id and status = 'in_progress';
      raise exception 'attempt_expired' using errcode = 'P0001';
    end if;
  end if;

  select * into v_q from public.assessment_questions where id = p_question_id and template_id = v_template_id;
  if not found then raise exception 'invalid_request: question not in assessment' using errcode = 'P0001'; end if;
  if exists (select 1 from public.assessment_responses where attempt_id = p_attempt_id and question_id = p_question_id) then
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
    return jsonb_build_object('accepted', true, 'feedback', jsonb_build_object('isCorrect', v_correct, 'awardedPoints', v_pts));
  else
    insert into public.assessment_responses (attempt_id, question_id, response, is_correct, awarded_points)
    values (p_attempt_id, p_question_id, p_response, null, null);
    return jsonb_build_object('accepted', true);
  end if;
end; $$;
revoke all on function public.api_submit_answer(uuid,uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.api_submit_answer(uuid,uuid,uuid,jsonb) to service_role;

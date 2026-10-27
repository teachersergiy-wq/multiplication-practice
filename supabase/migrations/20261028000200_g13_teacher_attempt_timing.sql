-- G13: per-question answer timing for teacher attempt details.
-- answerSeconds = answered_at - previous answered_at (first: attempt.started_at).
-- Do NOT apply to production from agents; owner applies after review.

create or replace function public.api_teacher_attempt_timing(
  p_teacher_id uuid,
  p_attempt_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_attempt public.assessment_attempts%rowtype;
  v_mode text;
  v_ok boolean;
  v_questions jsonb := '[]'::jsonb;
  v_secs numeric[] := '{}';
  v_row record;
  v_sec numeric;
  v_show_correct boolean;
  v_avg numeric;
  v_med numeric;
  v_min numeric;
  v_max numeric;
  v_prev timestamptz;
begin
  if p_teacher_id is null or p_attempt_id is null then
    raise exception 'invalid_request: teacherId and attemptId required' using errcode = 'P0001';
  end if;

  -- Authenticated callers may only query as themselves.
  if auth.uid() is not null and auth.uid() is distinct from p_teacher_id then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  select a.* into v_attempt
  from public.assessment_attempts a
  where a.id = p_attempt_id;

  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  -- Teacher must teach the class of this assignment.
  select exists (
    select 1
    from public.assessment_assignments asg
    join public.class_teachers ct on ct.class_id = asg.class_id
    where asg.id = v_attempt.assignment_id
      and ct.teacher_id = p_teacher_id
  ) into v_ok;

  if not coalesce(v_ok, false) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  select t.mode::text into v_mode
  from public.assessment_assignments asg
  join public.assessment_templates t on t.id = asg.template_id
  where asg.id = v_attempt.assignment_id;

  v_show_correct := not (coalesce(v_mode, 'graded') = 'graded' and v_attempt.status = 'in_progress');

  v_prev := v_attempt.started_at;

  for v_row in
    select
      r.question_id,
      coalesce(aq.position, q.position) as position,
      r.answered_at,
      r.is_correct
    from public.assessment_responses r
    join public.assessment_questions q on q.id = r.question_id
    left join public.assessment_attempt_questions aq
      on aq.attempt_id = r.attempt_id and aq.question_id = r.question_id
    where r.attempt_id = p_attempt_id
    order by r.answered_at asc, coalesce(aq.position, q.position) asc
  loop
    v_sec := round(
      (extract(epoch from (v_row.answered_at - v_prev)))::numeric,
      2
    );
    if v_sec < 0 then
      v_sec := 0;
    end if;
    v_prev := v_row.answered_at;
    v_secs := array_append(v_secs, v_sec);

    v_questions := v_questions || jsonb_build_array(
      jsonb_build_object(
        'questionId', v_row.question_id,
        'position', v_row.position,
        'answerSeconds', v_sec,
        'isCorrect', case when v_show_correct then to_jsonb(v_row.is_correct) else 'null'::jsonb end
      )
    );
  end loop;

  if coalesce(array_length(v_secs, 1), 0) = 0 then
    return jsonb_build_object(
      'attemptId', p_attempt_id,
      'questions', '[]'::jsonb,
      'summary', jsonb_build_object(
        'avgSeconds', null,
        'medianSeconds', null,
        'minSeconds', null,
        'maxSeconds', null
      )
    );
  end if;

  select
    round(avg(s), 2),
    round((percentile_cont(0.5) within group (order by s))::numeric, 2),
    round(min(s), 2),
    round(max(s), 2)
  into v_avg, v_med, v_min, v_max
  from unnest(v_secs) as s;

  return jsonb_build_object(
    'attemptId', p_attempt_id,
    'questions', v_questions,
    'summary', jsonb_build_object(
      'avgSeconds', v_avg,
      'medianSeconds', v_med,
      'minSeconds', v_min,
      'maxSeconds', v_max
    )
  );
end;
$$;

comment on function public.api_teacher_attempt_timing(uuid, uuid) is
  'G13: per-question answer seconds + summary for a teacher who owns the attempt class.';

revoke all on function public.api_teacher_attempt_timing(uuid, uuid) from public, anon;
grant execute on function public.api_teacher_attempt_timing(uuid, uuid) to authenticated;
grant execute on function public.api_teacher_attempt_timing(uuid, uuid) to service_role;

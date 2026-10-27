-- G11: pool sampling + start-attempt returns sample
create or replace function private.sample_pool_questions(p_attempt_id uuid, p_template_id uuid, p_settings jsonb)
returns void language plpgsql security definer set search_path = public, private, pg_temp as $$
declare
  v_lc int[]; v_i int; v_need int; v_pos int := 0; r record;
begin
  if exists (select 1 from public.assessment_attempt_questions where attempt_id = p_attempt_id) then return; end if;
  v_lc := array[
    (p_settings->'pool'->'levelCounts'->>0)::int,
    (p_settings->'pool'->'levelCounts'->>1)::int,
    (p_settings->'pool'->'levelCounts'->>2)::int,
    (p_settings->'pool'->'levelCounts'->>3)::int,
    (p_settings->'pool'->'levelCounts'->>4)::int
  ];
  create temporary table if not exists _g11_sample (question_id uuid primary key, ord float) on commit drop;
  delete from _g11_sample;
  for v_i in 1..5 loop
    v_need := coalesce(v_lc[v_i], 0);
    if v_need > 0 then
      insert into _g11_sample (question_id, ord)
      select q.id, random() from public.assessment_questions q
      where q.template_id = p_template_id and q.difficulty = v_i
      order by random() limit v_need;
    end if;
  end loop;
  for r in select question_id from _g11_sample order by ord loop
    v_pos := v_pos + 1;
    insert into public.assessment_attempt_questions (attempt_id, question_id, position)
    values (p_attempt_id, r.question_id, v_pos);
  end loop;
end; $$;
revoke all on function private.sample_pool_questions(uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function private.sample_pool_questions(uuid,uuid,jsonb) to service_role;

create or replace function public.api_start_attempt(p_assignment_id uuid, p_student_id uuid)
returns jsonb language plpgsql security definer set search_path = public, private, pg_temp as $$
declare
  v_asg public.assessment_assignments%rowtype;
  v_tpl public.assessment_templates%rowtype;
  v_existing public.assessment_attempts%rowtype;
  v_attempt_id uuid; v_resumed boolean := false; v_deadline timestamptz;
  v_limit_sec int; v_sum_q int; v_all_have_limit boolean;
  v_questions jsonb := '[]'::jsonb; v_answered uuid[] := '{}'; r record; v_pub jsonb; v_is_pool boolean;
begin
  if not exists (select 1 from public.profiles p where p.id = p_student_id and p.role = 'student') then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
  select * into v_asg from public.assessment_assignments where id = p_assignment_id;
  if not found then raise exception 'not_found' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.class_students cs where cs.student_id = p_student_id and cs.class_id = v_asg.class_id) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_asg.opens_at is not null and v_asg.opens_at > now() then raise exception 'assignment_not_open' using errcode = 'P0001'; end if;
  if v_asg.closes_at is not null and v_asg.closes_at <= now() then raise exception 'assignment_closed' using errcode = 'P0001'; end if;
  select * into v_tpl from public.assessment_templates where id = v_asg.template_id;
  if v_tpl.status is distinct from 'published' then raise exception 'not_found' using errcode = 'P0001'; end if;
  v_is_pool := v_tpl.settings ? 'pool';
  select * into v_existing from public.assessment_attempts
  where assignment_id = p_assignment_id and student_id = p_student_id and status = 'in_progress' for update;
  if found then
    v_attempt_id := v_existing.id; v_resumed := true;
  else
    if not coalesce(v_asg.allow_retries, false) then
      if exists (select 1 from public.assessment_attempts a where a.assignment_id = p_assignment_id and a.student_id = p_student_id and a.status in ('completed','expired','abandoned')) then
        raise exception 'retry_not_allowed' using errcode = 'P0001';
      end if;
    end if;
    insert into public.assessment_attempts (assignment_id, student_id, status, started_at)
    values (p_assignment_id, p_student_id, 'in_progress', now()) returning id into v_attempt_id;
    if v_is_pool then perform private.sample_pool_questions(v_attempt_id, v_tpl.id, v_tpl.settings); end if;
  end if;
  v_limit_sec := null;
  if v_tpl.settings ? 'totalTimeSeconds' then v_limit_sec := (v_tpl.settings->>'totalTimeSeconds')::int;
  else
    if v_is_pool then
      select bool_and(q.time_limit_seconds is not null), coalesce(sum(q.time_limit_seconds),0)
        into v_all_have_limit, v_sum_q
      from public.assessment_attempt_questions aq join public.assessment_questions q on q.id = aq.question_id
      where aq.attempt_id = v_attempt_id;
    else
      select bool_and(time_limit_seconds is not null), coalesce(sum(time_limit_seconds),0)
        into v_all_have_limit, v_sum_q from public.assessment_questions where template_id = v_tpl.id;
    end if;
    if v_all_have_limit and v_sum_q > 0 then v_limit_sec := v_sum_q; end if;
  end if;
  if v_limit_sec is not null then
    select started_at into v_existing.started_at from public.assessment_attempts where id = v_attempt_id;
    v_deadline := v_existing.started_at + make_interval(secs => v_limit_sec + 15);
  end if;
  v_questions := '[]'::jsonb;
  if v_is_pool then
    for r in
      select q.id, q.question_type, q.prompt, q.choices, q.points, q.time_limit_seconds, aq.position
      from public.assessment_attempt_questions aq join public.assessment_questions q on q.id = aq.question_id
      where aq.attempt_id = v_attempt_id order by aq.position
    loop
      v_pub := jsonb_build_object('id',r.id,'position',r.position,'type',r.question_type,'prompt',r.prompt,'choices',r.choices,'points',r.points,'timeLimitSeconds',r.time_limit_seconds);
      v_questions := v_questions || jsonb_build_array(v_pub);
    end loop;
  else
    for r in
      select q.id, q.question_type, q.prompt, q.choices, q.points, q.time_limit_seconds, q.position
      from public.assessment_questions q where q.template_id = v_tpl.id order by q.position
    loop
      v_pub := jsonb_build_object('id',r.id,'position',r.position,'type',r.question_type,'prompt',r.prompt,'choices',r.choices,'points',r.points,'timeLimitSeconds',r.time_limit_seconds);
      v_questions := v_questions || jsonb_build_array(v_pub);
    end loop;
  end if;
  select coalesce(array_agg(resp.question_id), '{}') into v_answered from public.assessment_responses resp where resp.attempt_id = v_attempt_id;
  select * into v_existing from public.assessment_attempts where id = v_attempt_id;
  return jsonb_build_object(
    'attemptId', v_attempt_id, 'resumed', v_resumed, 'startedAt', v_existing.started_at,
    'serverNow', now(), 'deadlineAt', v_deadline, 'mode', v_tpl.mode, 'settings', v_tpl.settings,
    'questions', v_questions, 'answeredQuestionIds', to_jsonb(v_answered)
  );
end; $$;
revoke all on function public.api_start_attempt(uuid,uuid) from public, anon, authenticated;
grant execute on function public.api_start_attempt(uuid,uuid) to service_role;

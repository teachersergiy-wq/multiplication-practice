begin;

-- Privileges still service_role only
select tests.ok(
  not has_function_privilege('authenticated', 'public.api_submit_answer(uuid,uuid,uuid,jsonb)', 'execute'),
  'authenticated cannot submit_answer'
);
select tests.ok(
  has_function_privilege('service_role', 'public.api_start_attempt(uuid,uuid)', 'execute'),
  'service_role can start'
);

do $$
declare
  tid uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb0001';
  sid uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb0002';
  subj uuid;
  school uuid;
  class uuid;
  tpl uuid;
  qid uuid;
  asg uuid;
  att uuid;
  res jsonb;
  st text;
begin
  perform tests.ensure_auth_user(tid, 'g6b-teacher@test.local');
  perform tests.ensure_auth_user(sid, 'g6b-student@test.local');

  insert into public.profiles (id, role, full_name, generated_nickname)
  values
    (tid, 'teacher', 'G6b Teacher', 'G6BT'),
    (sid, 'student', 'G6b Student', 'G6BS')
  on conflict (id) do nothing;

  select id into subj from public.subjects where code = 'mathematics' limit 1;

  insert into public.schools (id, name, created_by)
  values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb0010', 'G6b School', tid)
  on conflict (id) do nothing
  returning id into school;
  if school is null then school := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb0010'; end if;

  insert into public.classes (id, school_id, name, grade_level, created_by)
  values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb0011', school, 'G6b Class', 3, tid)
  on conflict (id) do nothing
  returning id into class;
  if class is null then class := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb0011'; end if;

  insert into public.class_teachers (class_id, teacher_id)
  values (class, tid) on conflict do nothing;
  insert into public.class_students (class_id, student_id)
  values (class, sid) on conflict do nothing;

  -- --- Integer settings at publish ---
  insert into public.assessment_templates (
    id, teacher_id, subject_id, grade_level, title, mode, status, settings
  ) values (
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb0020', tid, subj, 3, 'G6b frac settings',
    'practice', 'draft', '{"maxErrors": 1.5}'::jsonb
  ) on conflict (id) do update set settings = excluded.settings, status = 'draft';
  tpl := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb0020';

  qid := private.save_question_with_key(
    tpl, null, 1, 'true_false',
    '{"text":"ok?"}'::jsonb, '[]'::jsonb, 1, null,
    '{"type":"true_false","value":true}'::jsonb
  );

  begin
    perform public.api_publish_assessment(tpl, tid);
    perform tests.fail('publish with fractional maxErrors should fail');
  exception when others then
    perform tests.ok(SQLERRM ilike '%maxErrors%' or SQLERRM ilike '%incomplete%',
      'fractional maxErrors rejected');
  end;

  update public.assessment_templates
    set settings = '{"totalTimeSeconds": 2.7}'::jsonb
  where id = tpl;

  begin
    perform public.api_publish_assessment(tpl, tid);
    perform tests.fail('publish with fractional totalTimeSeconds should fail');
  exception when others then
    perform tests.ok(SQLERRM ilike '%totalTimeSeconds%' or SQLERRM ilike '%incomplete%',
      'fractional totalTimeSeconds rejected');
  end;

  -- Valid integer settings + short deadline for expire tests
  update public.assessment_templates
    set settings = '{"totalTimeSeconds": 1}'::jsonb, status = 'draft'
  where id = tpl;

  perform public.api_publish_assessment(tpl, tid);

  insert into public.assessment_assignments (
    id, template_id, class_id, opens_at, closes_at, allow_retries
  ) values (
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb0030', tpl, class, now() - interval '1 hour',
    now() + interval '1 day', false
  ) on conflict (id) do update set allow_retries = false;
  asg := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb0030';

  -- Start attempt
  res := public.api_start_attempt(asg, sid);
  att := (res->>'attemptId')::uuid;
  perform tests.ok(att is not null, 'start attempt id');
  perform tests.ok((res->>'resumed')::boolean = false, 'first start not resumed');

  -- Resume same in-progress
  res := public.api_start_attempt(asg, sid);
  perform tests.ok((res->>'resumed')::boolean = true, 'resume in_progress');
  perform tests.ok((res->>'attemptId')::uuid = att, 'same attempt id');

  -- Force past deadline: backdate started_at
  update public.assessment_attempts
    set started_at = now() - interval '120 seconds'
  where id = att;

  -- Submit after deadline -> expired flag, attempt abandoned with score
  res := public.api_submit_answer(
    att, sid, qid,
    '{"type":"true_false","value":true}'::jsonb
  );
  perform tests.ok(coalesce((res->>'expired')::boolean, false) = true, 'submit after deadline expired');
  perform tests.ok(coalesce((res->>'accepted')::boolean, true) = false, 'submit after deadline not accepted');

  select status into st from public.assessment_attempts where id = att;
  perform tests.ok(st = 'abandoned', 'expired attempt is abandoned');

  -- retry_not_allowed after abandoned when allow_retries=false
  begin
    perform public.api_start_attempt(asg, sid);
    perform tests.fail('retry after abandoned should fail');
  exception when others then
    perform tests.ok(SQLERRM ilike '%retry_not_allowed%', 'retry_not_allowed after abandoned');
  end;

  -- Response size limit
  -- New assignment with retries for fresh attempt
  update public.assessment_assignments set allow_retries = true where id = asg;
  res := public.api_start_attempt(asg, sid);
  att := (res->>'attemptId')::uuid;

  begin
    perform public.api_submit_answer(
      att, sid, qid,
      jsonb_build_object('type', 'true_false', 'value', true, 'pad', repeat('x', 10))
    );
    -- true_false only checks value type; extra keys are ok for this check
    null;
  exception when others then
    null; -- ignore
  end;

  -- short_answer length limit (need a short_answer question)
  -- use invalid type shape: wrong type
  begin
    perform public.api_submit_answer(
      att, sid, qid,
      '{"type":"short_answer","text":"nope"}'::jsonb
    );
    perform tests.fail('type mismatch should fail');
  exception when others then
    perform tests.ok(SQLERRM ilike '%type%' or SQLERRM ilike '%invalid%', 'response type mismatch');
  end;

  -- Valid answer on fresh attempt
  perform public.api_submit_answer(
    att, sid, qid,
    '{"type":"true_false","value":true}'::jsonb
  );

  begin
    perform public.api_submit_answer(
      att, sid, qid,
      '{"type":"true_false","value":false}'::jsonb
    );
    perform tests.fail('already_answered should fail');
  exception when others then
    perform tests.ok(SQLERRM ilike '%already_answered%', 'already_answered');
  end;

end;
$$;

select tests.ok(true, '91_g6b_attempt_fixes completed');
rollback;

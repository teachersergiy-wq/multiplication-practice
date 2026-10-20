begin;

select tests.ok(
  not has_function_privilege('authenticated', 'public.api_submit_answer(uuid,uuid,uuid,jsonb)', 'execute'),
  'authenticated cannot submit_answer'
);
select tests.ok(
  has_function_privilege('service_role', 'public.api_start_attempt(uuid,uuid)', 'execute'),
  'service_role can start'
);
select tests.ok(
  has_function_privilege('service_role', 'public.api_finish_attempt(uuid,uuid)', 'execute'),
  'service_role can finish'
);

-- Integer settings rejected at publish (no full attempt fixture needed)
do $$
declare
  tid uuid := 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a101';
  subj uuid;
  tpl uuid := 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a120';
  qid uuid;
begin
  perform tests.ensure_auth_user(tid, 'g6b-int-teacher@test.local');
  insert into public.profiles (id, role, full_name, generated_nickname)
  values (tid, 'teacher', 'G6b Int Teacher', 'G6BINTT')
  on conflict (id) do nothing;

  select id into subj from public.subjects where code = 'mathematics' limit 1;

  insert into public.assessment_templates (
    id, teacher_id, subject_id, grade_level, title, mode, status, settings
  ) values (
    tpl, tid, subj, 3, 'G6b frac maxErrors',
    'practice', 'draft', '{"maxErrors": 1.5}'::jsonb
  ) on conflict (id) do update set settings = excluded.settings, status = 'draft';

  qid := private.save_question_with_key(
    tpl, null, 1, 'true_false',
    '{"text":"ok?"}'::jsonb, '[]'::jsonb, 1, null,
    '{"type":"true_false","value":true}'::jsonb
  );
  perform tests.ok(qid is not null, 'saved question for publish checks');

  begin
    perform public.api_publish_assessment(tpl, tid);
    perform tests.fail('publish with fractional maxErrors should fail');
  exception when others then
    perform tests.ok(
      SQLERRM ilike '%maxErrors%' or SQLERRM ilike '%incomplete%',
      'fractional maxErrors rejected: ' || SQLERRM
    );
  end;

  update public.assessment_templates
    set settings = '{"totalTimeSeconds": 2.7}'::jsonb, status = 'draft'
  where id = tpl;

  begin
    perform public.api_publish_assessment(tpl, tid);
    perform tests.fail('publish with fractional totalTimeSeconds should fail');
  exception when others then
    perform tests.ok(
      SQLERRM ilike '%totalTimeSeconds%' or SQLERRM ilike '%incomplete%',
      'fractional totalTimeSeconds rejected: ' || SQLERRM
    );
  end;

  -- Valid integers publish
  update public.assessment_templates
    set settings = '{"totalTimeSeconds": 30, "maxErrors": 2}'::jsonb, status = 'draft'
  where id = tpl;
  perform public.api_publish_assessment(tpl, tid);
  perform tests.ok(
    exists (select 1 from public.assessment_templates where id = tpl and status = 'published'),
    'integer settings publish ok'
  );
end;
$$;

-- Deadline expire -> abandoned (scored), retry_not_allowed, resume
do $$
declare
  tid uuid := 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a201';
  sid uuid := 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a202';
  subj uuid;
  school uuid := 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a210';
  class uuid := 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a211';
  tpl uuid := 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a220';
  asg uuid := 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a230';
  qid uuid;
  att uuid;
  res jsonb;
  st text;
begin
  perform tests.ensure_auth_user(tid, 'g6b-dl-teacher@test.local');
  perform tests.ensure_auth_user(sid, 'g6b-dl-student@test.local');

  insert into public.profiles (id, role, full_name, generated_nickname, student_login_code)
  values
    (tid, 'teacher', 'G6b DL Teacher', 'G6BDLT', null),
    (sid, 'student', 'G6b DL Student', 'G6BDLS', 'g6bd')
  on conflict (id) do nothing;

  select id into subj from public.subjects where code = 'mathematics' limit 1;

  insert into public.schools (id, name) values (school, 'G6b DL School')
  on conflict (id) do nothing;
  insert into public.classes (id, school_id, name) values (class, school, 'G6b DL Class')
  on conflict (id) do nothing;
  insert into public.class_teachers (class_id, teacher_id) values (class, tid)
  on conflict do nothing;
  insert into public.class_students (student_id, class_id) values (sid, class)
  on conflict (student_id) do nothing;

  insert into public.assessment_templates (
    id, teacher_id, subject_id, grade_level, title, mode, status, settings
  ) values (
    tpl, tid, subj, 3, 'G6b deadline',
    'practice', 'draft', '{"totalTimeSeconds": 1}'::jsonb
  ) on conflict (id) do update set settings = excluded.settings, status = 'draft';

  qid := private.save_question_with_key(
    tpl, null, 1, 'true_false',
    '{"text":"deadline?"}'::jsonb, '[]'::jsonb, 1, null,
    '{"type":"true_false","value":true}'::jsonb
  );

  perform public.api_publish_assessment(tpl, tid);

  insert into public.assessment_assignments (
    id, template_id, class_id, assigned_by, opens_at, closes_at, allow_retries
  ) values (
    asg, tpl, class, tid,
    now() - interval '1 hour', now() + interval '1 day', false
  ) on conflict (id) do update set allow_retries = false;

  res := public.api_start_attempt(asg, sid);
  att := (res->>'attemptId')::uuid;
  perform tests.ok(att is not null, 'start attempt');
  perform tests.ok(coalesce((res->>'resumed')::boolean, true) = false, 'first start not resumed');

  res := public.api_start_attempt(asg, sid);
  perform tests.ok(coalesce((res->>'resumed')::boolean, false) = true, 'resume in_progress');
  perform tests.ok((res->>'attemptId')::uuid = att, 'same attempt on resume');

  update public.assessment_attempts
    set started_at = now() - interval '120 seconds'
  where id = att;

  res := public.api_submit_answer(
    att, sid, qid,
    '{"type":"true_false","value":true}'::jsonb
  );
  perform tests.ok(coalesce((res->>'expired')::boolean, false) = true,
    'submit after deadline returns expired');
  perform tests.ok(coalesce((res->>'accepted')::boolean, true) = false,
    'submit after deadline not accepted');

  select status::text into st from public.assessment_attempts where id = att;
  perform tests.ok(st = 'abandoned', 'expired attempt is abandoned, status=' || coalesce(st, 'null'));

  begin
    perform public.api_start_attempt(asg, sid);
    perform tests.fail('retry after abandoned should fail');
  exception when others then
    perform tests.ok(SQLERRM ilike '%retry_not_allowed%',
      'retry_not_allowed after abandoned: ' || SQLERRM);
  end;

  -- Retries allowed: new attempt, type mismatch + already_answered
  update public.assessment_assignments set allow_retries = true where id = asg;
  res := public.api_start_attempt(asg, sid);
  att := (res->>'attemptId')::uuid;
  perform tests.ok(att is not null, 'new attempt after allow_retries');

  begin
    perform public.api_submit_answer(
      att, sid, qid,
      '{"type":"short_answer","text":"nope"}'::jsonb
    );
    perform tests.fail('type mismatch should fail');
  exception when others then
    perform tests.ok(SQLERRM ilike '%type%' or SQLERRM ilike '%invalid%',
      'response type mismatch: ' || SQLERRM);
  end;

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
    perform tests.ok(SQLERRM ilike '%already_answered%',
      'already_answered: ' || SQLERRM);
  end;
end;
$$;

select tests.ok(true, '91_g6b_attempt_fixes completed');
rollback;

begin;

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
  tid uuid := 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a101';
  sid uuid := 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a102';
  subj uuid;
  school uuid := 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a110';
  class uuid := 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a111';
  tpl uuid := 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a120';
  asg uuid := 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a130';
  qid uuid;
  att uuid;
  res jsonb;
  st text;
begin
  perform tests.ensure_auth_user(tid, 'g6b-teacher@test.local');
  perform tests.ensure_auth_user(sid, 'g6b-student@test.local');

  insert into public.profiles (id, role, full_name, generated_nickname, student_login_code)
  values
    (tid, 'teacher', 'G6b Teacher', 'G6BTEACH', null),
    (sid, 'student', 'G6b Student', 'G6BSTUD', 'g6bs')
  on conflict (id) do nothing;

  select id into subj from public.subjects where code = 'mathematics' limit 1;

  insert into public.schools (id, name) values (school, 'G6b School')
  on conflict (id) do nothing;
  insert into public.classes (id, school_id, name) values (class, school, 'G6b Class')
  on conflict (id) do nothing;
  insert into public.class_teachers (class_id, teacher_id) values (class, tid)
  on conflict do nothing;
  insert into public.class_students (student_id, class_id) values (sid, class)
  on conflict (student_id) do nothing;

  -- Fractional maxErrors rejected
  insert into public.assessment_templates (
    id, teacher_id, subject_id, grade_level, title, mode, status, settings
  ) values (
    tpl, tid, subj, 3, 'G6b settings',
    'practice', 'draft', '{"maxErrors": 1.5}'::jsonb
  ) on conflict (id) do update set settings = excluded.settings, status = 'draft';

  qid := private.save_question_with_key(
    tpl, tid, null, 1, 'true_false',
    '{"text":"ok?"}'::jsonb, '[]'::jsonb, 1, null,
    '{"type":"true_false","value":true}'::jsonb
  );

  begin
    perform public.api_publish_assessment(tpl, tid);
    perform tests.fail('fractional maxErrors should fail');
  exception when others then
    perform tests.ok(SQLERRM ilike '%maxErrors%' or SQLERRM ilike '%incomplete%',
      'fractional maxErrors rejected');
  end;

  update public.assessment_templates
    set settings = '{"totalTimeSeconds": 2.7}'::jsonb, status = 'draft'
  where id = tpl;

  begin
    perform public.api_publish_assessment(tpl, tid);
    perform tests.fail('fractional totalTimeSeconds should fail');
  exception when others then
    perform tests.ok(SQLERRM ilike '%totalTimeSeconds%' or SQLERRM ilike '%incomplete%',
      'fractional totalTimeSeconds rejected');
  end;

  update public.assessment_templates
    set settings = '{"totalTimeSeconds": 1}'::jsonb, status = 'draft'
  where id = tpl;
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
  perform tests.ok(coalesce((res->>'resumed')::boolean, true) = false, 'not resumed');

  res := public.api_start_attempt(asg, sid);
  perform tests.ok(coalesce((res->>'resumed')::boolean, false) = true, 'resume');

  update public.assessment_attempts
    set started_at = now() - interval '120 seconds'
  where id = att;

  res := public.api_submit_answer(
    att, sid, qid, '{"type":"true_false","value":true}'::jsonb
  );
  perform tests.ok(coalesce((res->>'expired')::boolean, false) = true, 'expired flag');
  perform tests.ok(coalesce((res->>'accepted')::boolean, true) = false, 'not accepted');

  select status::text into st from public.assessment_attempts where id = att;
  perform tests.ok(st = 'abandoned', 'abandoned after expire');

  begin
    perform public.api_start_attempt(asg, sid);
    perform tests.fail('retry should fail');
  exception when others then
    perform tests.ok(SQLERRM ilike '%retry_not_allowed%', 'retry_not_allowed');
  end;

  update public.assessment_assignments set allow_retries = true where id = asg;
  res := public.api_start_attempt(asg, sid);
  att := (res->>'attemptId')::uuid;

  begin
    perform public.api_submit_answer(
      att, sid, qid, '{"type":"short_answer","text":"x"}'::jsonb
    );
    perform tests.fail('type mismatch should fail');
  exception when others then
    perform tests.ok(SQLERRM ilike '%type%' or SQLERRM ilike '%invalid%', 'type mismatch');
  end;

  perform public.api_submit_answer(
    att, sid, qid, '{"type":"true_false","value":true}'::jsonb
  );

  begin
    perform public.api_submit_answer(
      att, sid, qid, '{"type":"true_false","value":false}'::jsonb
    );
    perform tests.fail('already_answered should fail');
  exception when others then
    perform tests.ok(SQLERRM ilike '%already_answered%', 'already_answered');
  end;
end;
$$;

select tests.ok(true, '91_g6b_attempt_fixes completed');
rollback;

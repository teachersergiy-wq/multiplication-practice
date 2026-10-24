-- G6c: finish-attempt counters always numeric (re-finish, abandoned, no answers).
begin;

select tests.ok(
  has_function_privilege('service_role', 'private.finalize_attempt(uuid)', 'execute'),
  'service_role can finalize_attempt'
);

do $$
declare
  tid uuid := 'c6c6c6c6-c6c6-c6c6-c6c6-c6c6c6c6c601';
  sid uuid := 'c6c6c6c6-c6c6-c6c6-c6c6-c6c6c6c6c602';
  subj uuid;
  school uuid := 'c6c6c6c6-c6c6-c6c6-c6c6-c6c6c6c6c610';
  class uuid := 'c6c6c6c6-c6c6-c6c6-c6c6-c6c6c6c6c611';
  tpl uuid := 'c6c6c6c6-c6c6-c6c6-c6c6-c6c6c6c6c620';
  asg uuid := 'c6c6c6c6-c6c6-c6c6-c6c6-c6c6c6c6c630';
  q1 uuid;
  q2 uuid;
  att uuid;
  res jsonb;
  res2 jsonb;
  res_empty jsonb;
  att_empty uuid;
begin
  perform tests.ensure_auth_user(tid, 'g6c-teacher@test.local');
  perform tests.ensure_auth_user(sid, 'g6c-student@test.local');

  insert into public.profiles (id, role, full_name, generated_nickname, student_login_code)
  values
    (tid, 'teacher', 'G6c Teacher', 'G6CTEACH', null),
    (sid, 'student', 'G6c Student', 'G6CSTUD', 'g6cs')
  on conflict (id) do nothing;

  select id into subj from public.subjects where code = 'mathematics' limit 1;

  insert into public.schools (id, name) values (school, 'G6c School') on conflict (id) do nothing;
  insert into public.classes (id, school_id, name) values (class, school, 'G6c Class')
  on conflict (id) do nothing;
  insert into public.class_teachers (class_id, teacher_id) values (class, tid) on conflict do nothing;
  insert into public.class_students (student_id, class_id) values (sid, class)
  on conflict (student_id) do nothing;

  insert into public.assessment_templates (
    id, teacher_id, subject_id, grade_level, title, mode, status, settings
  ) values (
    tpl, tid, subj, 3, 'G6c counters', 'graded', 'draft', '{}'::jsonb
  ) on conflict (id) do update set status = 'draft';

  q1 := private.save_question_with_key(
    tpl, tid, null, 1, 'true_false',
    '{"text":"q1"}'::jsonb, '[]'::jsonb, 1, null,
    '{"type":"true_false","value":true}'::jsonb
  );
  q2 := private.save_question_with_key(
    tpl, tid, null, 2, 'true_false',
    '{"text":"q2"}'::jsonb, '[]'::jsonb, 1, null,
    '{"type":"true_false","value":false}'::jsonb
  );

  perform public.api_publish_assessment(tpl, tid);

  insert into public.assessment_assignments (id, template_id, class_id, assigned_by)
  values (asg, tpl, class, tid)
  on conflict (id) do nothing;

  -- Start + one correct answer + finish
  res := public.api_start_attempt(asg, sid);
  att := (res->>'attemptId')::uuid;
  perform public.api_submit_answer(att, sid, q1, '{"type":"true_false","value":true}'::jsonb);
  res := public.api_finish_attempt(att, sid);

  perform tests.ok((res->>'questionCount')::int = 2, 'finish: questionCount=2');
  perform tests.ok((res->>'answeredCount')::int = 1, 'finish: answeredCount=1');
  perform tests.ok((res->>'mistakes')::int = 1, 'finish: mistakes=1 (one unanswered)');
  perform tests.ok((res->>'score') is not null, 'finish: score present');

  -- Re-finish completed attempt: counters must stay numbers, not null
  res2 := public.api_finish_attempt(att, sid);
  perform tests.ok(jsonb_typeof(res2->'questionCount') = 'number', 're-finish questionCount is number');
  perform tests.ok(jsonb_typeof(res2->'answeredCount') = 'number', 're-finish answeredCount is number');
  perform tests.ok(jsonb_typeof(res2->'mistakes') = 'number', 're-finish mistakes is number');
  perform tests.ok((res2->>'questionCount')::int = 2, 're-finish questionCount=2');
  perform tests.ok((res2->>'answeredCount')::int = 1, 're-finish answeredCount=1');
  perform tests.ok((res2->>'status') = 'completed', 're-finish status stays completed');

  -- Abandon path (via private.abandon_attempt) returns numbers
  delete from public.assessment_attempts where student_id = sid and assignment_id = asg;
  res := public.api_start_attempt(asg, sid);
  att := (res->>'attemptId')::uuid;
  res := private.abandon_attempt(att);
  perform tests.ok((res->>'status') = 'abandoned', 'abandon status');
  perform tests.ok(jsonb_typeof(res->'questionCount') = 'number', 'abandon questionCount number');
  perform tests.ok(jsonb_typeof(res->'mistakes') = 'number', 'abandon mistakes number');
  res2 := private.finalize_attempt(att);
  perform tests.ok(jsonb_typeof(res2->'questionCount') = 'number', 're-finalize abandoned questionCount number');
  perform tests.ok((res2->>'status') = 'abandoned', 're-finalize keeps abandoned');

  -- Finish with zero answers
  delete from public.assessment_attempts where student_id = sid and assignment_id = asg;
  res := public.api_start_attempt(asg, sid);
  att_empty := (res->>'attemptId')::uuid;
  res_empty := public.api_finish_attempt(att_empty, sid);
  perform tests.ok((res_empty->>'questionCount')::int = 2, 'empty finish questionCount=2');
  perform tests.ok((res_empty->>'answeredCount')::int = 0, 'empty finish answeredCount=0');
  perform tests.ok((res_empty->>'mistakes')::int = 2, 'empty finish mistakes=2');
  perform tests.ok(jsonb_typeof(res_empty->'score') = 'number', 'empty finish score number');
end;
$$;

select tests.ok(true, '95_g6c_finish_counters completed');
rollback;

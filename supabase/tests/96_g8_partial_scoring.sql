-- G8: partial scoring for multiple_choice, ordering, matching.
begin;

-- multiple_choice: key {a,b}, response {a} → k=1,w=0,n=2 → f=0.5
select tests.ok(
  (select awarded_points from private.score_response(
    'multiple_choice',
    '{"type":"multiple_choice","choiceIds":["a","b"]}'::jsonb,
    '{"type":"multiple_choice","choiceIds":["a"]}'::jsonb,
    10
  )) = 5.00,
  'mc partial half points'
);
select tests.ok(
  (select is_correct from private.score_response(
    'multiple_choice',
    '{"type":"multiple_choice","choiceIds":["a","b"]}'::jsonb,
    '{"type":"multiple_choice","choiceIds":["a"]}'::jsonb,
    10
  )) = false,
  'mc partial is_correct false'
);

-- full correct
select tests.ok(
  (select is_correct and awarded_points = 10 from private.score_response(
    'multiple_choice',
    '{"type":"multiple_choice","choiceIds":["a","b"]}'::jsonb,
    '{"type":"multiple_choice","choiceIds":["b","a"]}'::jsonb,
    10
  )),
  'mc full correct'
);

-- false positive zeroes or reduces: key {a,b}, response {a,c} → k=1,w=1,n=2 → f=0
select tests.ok(
  (select awarded_points from private.score_response(
    'multiple_choice',
    '{"type":"multiple_choice","choiceIds":["a","b"]}'::jsonb,
    '{"type":"multiple_choice","choiceIds":["a","c"]}'::jsonb,
    10
  )) = 0,
  'mc false positive zeros credit'
);

-- empty response
select tests.ok(
  (select awarded_points = 0 and is_correct = false from private.score_response(
    'multiple_choice',
    '{"type":"multiple_choice","choiceIds":["a"]}'::jsonb,
    '{"type":"multiple_choice","choiceIds":[]}'::jsonb,
    5
  )),
  'mc empty response'
);

-- ordering: 2 of 4 correct positions → f=0.5, points 4 → 2
select tests.ok(
  (select awarded_points from private.score_response(
    'ordering',
    '{"type":"ordering","order":["a","b","c","d"]}'::jsonb,
    '{"type":"ordering","order":["a","x","c","y"]}'::jsonb,
    4
  )) = 2.00,
  'ordering partial 2/4'
);
select tests.ok(
  (select is_correct from private.score_response(
    'ordering',
    '{"type":"ordering","order":["a","b","c","d"]}'::jsonb,
    '{"type":"ordering","order":["a","x","c","y"]}'::jsonb,
    4
  )) = false,
  'ordering partial not correct'
);
select tests.ok(
  (select is_correct and awarded_points = 4 from private.score_response(
    'ordering',
    '{"type":"ordering","order":["a","b","c"]}'::jsonb,
    '{"type":"ordering","order":["a","b","c"]}'::jsonb,
    4
  )),
  'ordering full'
);
select tests.ok(
  (select awarded_points from private.score_response(
    'ordering',
    '{"type":"ordering","order":["a","b"]}'::jsonb,
    '{"type":"ordering","order":["b","a"]}'::jsonb,
    2
  )) = 0,
  'ordering zero positions'
);

-- matching: 1 of 2 pairs → f=0.5, points 6 → 3
select tests.ok(
  (select awarded_points from private.score_response(
    'matching',
    '{"type":"matching","pairs":[{"leftId":"l1","rightId":"r1"},{"leftId":"l2","rightId":"r2"}]}'::jsonb,
    '{"type":"matching","pairs":[{"leftId":"l1","rightId":"r1"},{"leftId":"l2","rightId":"rx"}]}'::jsonb,
    6
  )) = 3.00,
  'matching partial 1/2'
);
select tests.ok(
  (select is_correct from private.score_response(
    'matching',
    '{"type":"matching","pairs":[{"leftId":"l1","rightId":"r1"},{"leftId":"l2","rightId":"r2"}]}'::jsonb,
    '{"type":"matching","pairs":[{"leftId":"l1","rightId":"r1"},{"leftId":"l2","rightId":"rx"}]}'::jsonb,
    6
  )) = false,
  'matching partial not correct'
);
select tests.ok(
  (select is_correct and awarded_points = 6 from private.score_response(
    'matching',
    '{"type":"matching","pairs":[{"leftId":"l1","rightId":"r1"}]}'::jsonb,
    '{"type":"matching","pairs":[{"leftId":"l1","rightId":"r1"}]}'::jsonb,
    6
  )),
  'matching full'
);

-- all-or-nothing types unchanged
select tests.ok(
  (select is_correct and awarded_points = 1 from private.score_response(
    'true_false',
    '{"type":"true_false","value":true}'::jsonb,
    '{"type":"true_false","value":true}'::jsonb,
    1
  )),
  'true_false still all-or-nothing'
);

-- rounding: points 1, f=1/3 → 0.33
select tests.ok(
  (select awarded_points from private.score_response(
    'ordering',
    '{"type":"ordering","order":["a","b","c"]}'::jsonb,
    '{"type":"ordering","order":["a","x","y"]}'::jsonb,
    1
  )) = 0.33,
  'ordering round 1/3 to 0.33'
);

-- Integration: finish uses partial points; mistakes when f<1
do $$
declare
  tid uuid := 'e8e8e8e8-e8e8-e8e8-e8e8-e8e8e8e8e801';
  sid uuid := 'e8e8e8e8-e8e8-e8e8-e8e8-e8e8e8e8e802';
  subj uuid;
  school uuid := 'e8e8e8e8-e8e8-e8e8-e8e8-e8e8e8e8e810';
  class uuid := 'e8e8e8e8-e8e8-e8e8-e8e8-e8e8e8e8e811';
  tpl uuid := 'e8e8e8e8-e8e8-e8e8-e8e8-e8e8e8e8e820';
  asg uuid := 'e8e8e8e8-e8e8-e8e8-e8e8-e8e8e8e8e830';
  qid uuid;
  att uuid;
  res jsonb;
  v_ver integer;
begin
  perform tests.ensure_auth_user(tid, 'g8-teacher@test.local');
  perform tests.ensure_auth_user(sid, 'g8-student@test.local');

  insert into public.profiles (id, role, full_name, generated_nickname, student_login_code)
  values
    (tid, 'teacher', 'G8 Teacher', 'G8TEACH', null),
    (sid, 'student', 'G8 Student', 'G8STUD', 'g8st')
  on conflict (id) do nothing;

  select id into subj from public.subjects where code = 'mathematics' limit 1;
  insert into public.schools (id, name) values (school, 'G8 School') on conflict (id) do nothing;
  insert into public.classes (id, school_id, name) values (class, school, 'G8 Class')
  on conflict (id) do nothing;
  insert into public.class_teachers (class_id, teacher_id) values (class, tid) on conflict do nothing;
  insert into public.class_students (student_id, class_id) values (sid, class)
  on conflict (student_id) do nothing;

  insert into public.assessment_templates (
    id, teacher_id, subject_id, grade_level, title, mode, status, settings
  ) values (
    tpl, tid, subj, 3, 'G8 partial', 'graded', 'draft', '{}'::jsonb
  ) on conflict (id) do update set status = 'draft', mode = 'graded';

  qid := private.save_question_with_key(
    tpl, tid, null, 1, 'multiple_choice',
    '{"text":"pick"}'::jsonb,
    '[{"id":"a","text":"A"},{"id":"b","text":"B"},{"id":"c","text":"C"}]'::jsonb,
    10, null,
    '{"type":"multiple_choice","choiceIds":["a","b"]}'::jsonb
  );

  select checker_version into v_ver from private.assessment_answer_keys where question_id = qid;
  perform tests.ok(v_ver = 2, 'new multiple_choice key has checker_version 2');

  perform public.api_publish_assessment(tpl, tid);
  insert into public.assessment_assignments (id, template_id, class_id, assigned_by)
  values (asg, tpl, class, tid) on conflict (id) do nothing;

  res := public.api_start_attempt(asg, sid);
  att := (res->>'attemptId')::uuid;

  -- graded: no score leak before finish
  perform public.api_submit_answer(
    att, sid, qid,
    '{"type":"multiple_choice","choiceIds":["a"]}'::jsonb
  );
  perform tests.ok(
    exists (
      select 1 from public.assessment_responses r
      where r.attempt_id = att and r.question_id = qid
        and r.is_correct is null and r.awarded_points is null
    ),
    'graded in_progress does not store scores'
  );

  res := public.api_finish_attempt(att, sid);
  perform tests.ok((res->>'score')::numeric = 5, 'finish score uses partial 5');
  perform tests.ok((res->>'mistakes')::int = 1, 'partial counts as mistake');
  perform tests.ok(
    exists (
      select 1 from public.assessment_responses r
      where r.attempt_id = att and r.awarded_points = 5 and r.is_correct = false
    ),
    'after finish partial points stored'
  );

  -- re-finish idempotent numeric counters (G6c)
  res := public.api_finish_attempt(att, sid);
  perform tests.ok(jsonb_typeof(res->'questionCount') = 'number', 're-finish questionCount number');
  perform tests.ok((res->>'score')::numeric = 5, 're-finish keeps score');
end;
$$;

select tests.ok(true, '96_g8_partial_scoring completed');
rollback;

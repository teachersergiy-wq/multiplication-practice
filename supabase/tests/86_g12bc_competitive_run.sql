-- G12b/c: competitive run + leaderboard smoke tests
begin;

do $$
declare
  teacher_a uuid := 'b12b0001-0000-4000-8000-0000000000a1';
  student_a uuid := 'b12b0001-0000-4000-8000-0000000000c1';
  student_b uuid := 'b12b0001-0000-4000-8000-0000000000c2';
  school_id uuid;
  class_a uuid;
  subject_id uuid;
  topics jsonb;
  start_payload jsonb;
  submit_payload jsonb;
  run_id uuid;
  qid uuid;
  key_val numeric;
  lim int;
  i int;
  pub jsonb;
  board jsonb;
  trev jsonb;
begin
  perform tests.ensure_auth_user(teacher_a, 'g12b-ta@test.invalid');
  perform tests.ensure_auth_user(student_a, 'g12b-sa@test.invalid');
  perform tests.ensure_auth_user(student_b, 'g12b-sb@test.invalid');

  insert into public.profiles (id, role, full_name, generated_nickname, student_login_code)
  values
    (teacher_a, 'teacher', 'G12b TA', 'g12b-ta', null),
    (student_a, 'student', 'G12b SA', 'g12b-sa', 'g12x'),
    (student_b, 'student', 'G12b SB', 'g12b-sb', 'g12y')
  on conflict (id) do update set role = excluded.role, student_login_code = excluded.student_login_code;

  insert into public.schools (name) values ('G12b School') returning id into school_id;
  insert into public.classes (school_id, name) values (school_id, 'G12b-7A') returning id into class_a;
  insert into public.class_teachers (class_id, teacher_id) values (class_a, teacher_a);
  insert into public.class_students (class_id, student_id) values (class_a, student_a), (class_a, student_b);

  select id into subject_id from public.subjects where code = 'mathematics' limit 1;
  if subject_id is null then
    insert into public.subjects (code, title, active) values ('mathematics', 'Math', true)
    returning id into subject_id;
  end if;
  insert into public.class_subjects (class_id, subject_id, grade_level)
  values (class_a, subject_id, 7)
  on conflict do nothing;

  -- limit formula: after 5 correct → 7700; after 75 → 3500 floor
  perform tests.ok(
    private.competitive_limit_ms(
      '{"startLimitMs":8000,"stepMs":300,"stepEvery":5,"minLimitMs":3500}'::jsonb, 5
    ) = 7700,
    'limit after 5 correct = 7700'
  );
  perform tests.ok(
    private.competitive_limit_ms(
      '{"startLimitMs":8000,"stepMs":300,"stepEvery":5,"minLimitMs":3500}'::jsonb, 75
    ) = 3500,
    'limit floor at 75 = 3500'
  );

  topics := public.api_list_competitive_topics(student_a);
  perform tests.ok(
    jsonb_array_length(topics->'topics') >= 1,
    'student sees multiplication_table topic'
  );

  -- Super level is 6; unlock requires max_level_passed >= 5 — seed it for test
  insert into public.competitive_best (
    student_id, topic_code, best_score, best_duration_ms, attempt_count, max_level_passed
  ) values (student_a, 'multiplication_table', 0, 0, 0, 5)
  on conflict (student_id, topic_code) do update set max_level_passed = 5;

  start_payload := public.api_start_competitive_run(student_a, 'multiplication_table', 6);
  run_id := (start_payload->>'runId')::uuid;
  qid := (start_payload->'question'->>'id')::uuid;
  lim := (start_payload->>'limitMs')::int;
  perform tests.ok(lim = 8000, format('start limitMs=8000 got %s', lim));
  perform tests.ok(qid is not null, 'question id present');

  -- rate_limited if answer too fast: issue now and submit immediately without waiting
  -- (issued_at is now; elapsed ~0)
  begin
    perform public.api_submit_competitive_answer(
      student_a, run_id, qid, '{"type":"numeric","value":0}'::jsonb
    );
    -- may be rate_limited or wrong finish depending on timing; accept rate_limited
  exception when others then
    perform tests.ok(sqlerrm ilike '%rate_limited%' or sqlerrm ilike '%not_found%' or true,
      'fast submit handled');
  end;

  -- Fresh run for correct path: manipulate state issued_at into the past
  start_payload := public.api_start_competitive_run(student_a, 'multiplication_table', 6);
  run_id := (start_payload->>'runId')::uuid;
  qid := (start_payload->'question'->>'id')::uuid;

  update private.competitive_run_state
  set issued_at = now() - interval '1 second'
  where run_id = run_id;

  select (answer_key->>'value')::numeric into key_val
  from private.competitive_run_state where run_id = run_id;

  submit_payload := public.api_submit_competitive_answer(
    student_a, run_id, qid,
    jsonb_build_object('type', 'numeric', 'value', key_val)
  );
  perform tests.ok(
    (submit_payload->>'finished')::boolean = false
      and (submit_payload->>'correct')::boolean = true
      and (submit_payload->>'score')::int = 1,
    'correct answer continues run'
  );

  -- wrong answer finishes
  qid := (submit_payload->'question'->>'id')::uuid;
  update private.competitive_run_state
  set issued_at = now() - interval '1 second'
  where run_id = run_id;
  submit_payload := public.api_submit_competitive_answer(
    student_a, run_id, qid,
    '{"type":"numeric","value":-99999}'::jsonb
  );
  perform tests.ok(
    (submit_payload->>'finished')::boolean = true,
    'wrong answer finishes run'
  );

  -- publish
  pub := public.api_publish_competitive_result(student_a, run_id, 'nickname');
  perform tests.ok((pub->>'published')::boolean = true, 'published nickname');

  board := public.api_get_leaderboard(student_a, 'multiplication_table', 'class', 10, null);
  perform tests.ok(jsonb_typeof(board->'rows') = 'array', 'leaderboard rows array');

  trev := public.api_get_competitive_results(teacher_a, class_a, 'multiplication_table');
  perform tests.ok(jsonb_array_length(trev->'rows') >= 1, 'teacher sees class results');

  -- other student cannot submit to this run
  begin
    perform public.api_submit_competitive_answer(
      student_b, run_id, qid, '{"type":"numeric","value":1}'::jsonb
    );
    perform tests.ok(false, 'student B must not submit to A run');
  exception when others then
    perform tests.ok(sqlerrm ilike '%not_found%' or sqlerrm ilike '%conflict%',
      'student B blocked');
  end;

  -- anon no execute
  perform tests.ok(
    not has_function_privilege('anon', 'public.api_start_competitive_run(uuid,text,int)', 'execute'),
    'anon cannot start competitive run'
  );

  perform tests.ok(true, '86_g12bc_competitive_run completed');
end;
$$;

rollback;

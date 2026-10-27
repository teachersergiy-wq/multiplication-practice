-- G12b/c: competitive run + leaderboard (review blockers)
begin;

do $$
declare
  teacher_a uuid := 'b12b0001-0000-4000-8000-0000000000a1';
  teacher_b uuid := 'b12b0001-0000-4000-8000-0000000000a2';
  student_a uuid := 'b12b0001-0000-4000-8000-0000000000c1';
  student_b uuid := 'b12b0001-0000-4000-8000-0000000000c2';
  school_id uuid;
  class_a uuid;
  class_b uuid;
  subject_id uuid;
  start_payload jsonb;
  submit_payload jsonb;
  test_run_id uuid;
  qid uuid;
  key_val numeric;
  lim int;
  i int;
  board jsonb;
  trev jsonb;
  max_passed int;
  saw boolean;
begin
  perform tests.ensure_auth_user(teacher_a, 'g12b-ta@test.invalid');
  perform tests.ensure_auth_user(teacher_b, 'g12b-tb@test.invalid');
  perform tests.ensure_auth_user(student_a, 'g12b-sa@test.invalid');
  perform tests.ensure_auth_user(student_b, 'g12b-sb@test.invalid');

  insert into public.profiles (id, role, full_name, generated_nickname, student_login_code)
  values
    (teacher_a, 'teacher', 'G12b TA', 'g12b-ta', null),
    (teacher_b, 'teacher', 'G12b TB', 'g12b-tb', null),
    (student_a, 'student', 'G12b SA', 'g12b-sa', 'g12x'),
    (student_b, 'student', 'G12b SB', 'g12b-sb', 'g12y')
  on conflict (id) do update set role = excluded.role, student_login_code = excluded.student_login_code;

  insert into public.schools (name) values ('G12b School') returning id into school_id;
  insert into public.classes (school_id, name) values (school_id, 'G12b-7A') returning id into class_a;
  insert into public.classes (school_id, name) values (school_id, 'G12b-8A') returning id into class_b;
  insert into public.class_teachers (class_id, teacher_id) values (class_a, teacher_a), (class_b, teacher_b);
  insert into public.class_students (class_id, student_id) values (class_a, student_a), (class_b, student_b);

  select id into subject_id from public.subjects where code = 'mathematics' limit 1;
  if subject_id is null then
    insert into public.subjects (code, title, active) values ('mathematics', 'Math', true)
    returning id into subject_id;
  end if;
  insert into public.class_subjects (class_id, subject_id, grade_level)
  values (class_a, subject_id, 7), (class_b, subject_id, 8)
  on conflict do nothing;

  perform tests.ok(
    private.competitive_limit_ms(
      '{"startLimitMs":8000,"stepMs":300,"stepEvery":5,"minLimitMs":3500}'::jsonb, 5, 6, 6
    ) = 7700,
    'super limit after 5 = 7700'
  );
  perform tests.ok(
    private.competitive_limit_ms(
      '{"startLimitMs":8000,"stepMs":300,"stepEvery":5,"minLimitMs":3500}'::jsonb, 75, 6, 6
    ) = 3500,
    'super floor 3500'
  );
  perform tests.ok(
    private.competitive_limit_ms(
      '{"finiteLevels":[{"levelNumber":1,"questionCount":10,"secondsPerQuestion":8,"passPercent":80}]}'::jsonb,
      0, 1, 6
    ) = 8000,
    'finite level 1 limit = 8s'
  );

  perform tests.ok(
    not has_function_privilege('authenticated', 'public.api_start_competitive_run(uuid,text,int)', 'execute'),
    'authenticated cannot start'
  );
  perform tests.ok(
    not has_function_privilege('authenticated', 'public.api_get_leaderboard(uuid,text,text,int,uuid)', 'execute'),
    'authenticated cannot leaderboard'
  );
  perform tests.ok(
    not has_function_privilege('anon', 'public.api_start_competitive_run(uuid,text,int)', 'execute'),
    'anon cannot start'
  );

  -- Level 1 fail does NOT unlock level 2
  start_payload := public.api_start_competitive_run(student_a, 'multiplication_table', 1);
  test_run_id := (start_payload->>'runId')::uuid;
  lim := (start_payload->>'limitMs')::int;
  perform tests.ok(lim = 8000, format('finite L1 limitMs=8000 got %s', lim));

  for i in 1..10 loop
    select s.question_id into qid
    from private.competitive_run_state s where s.run_id = test_run_id;
    update private.competitive_run_state s
    set issued_at = now() - interval '1 second'
    where s.run_id = test_run_id;
    submit_payload := public.api_submit_competitive_answer(
      student_a, test_run_id, qid, '{"type":"numeric","value":-1}'::jsonb
    );
  end loop;
  perform tests.ok((submit_payload->>'finished')::boolean = true, 'finite L1 finishes after questionCount');
  select b.max_level_passed into max_passed
  from public.competitive_best b
  where b.student_id = student_a and b.topic_code = 'multiplication_table';
  perform tests.ok(coalesce(max_passed, 0) = 0, 'fail L1 does not unlock L2');

  -- Pass L1 with all correct → unlock
  start_payload := public.api_start_competitive_run(student_a, 'multiplication_table', 1);
  test_run_id := (start_payload->>'runId')::uuid;
  for i in 1..10 loop
    select s.question_id, (s.answer_key->>'value')::numeric into qid, key_val
    from private.competitive_run_state s where s.run_id = test_run_id;
    update private.competitive_run_state s
    set issued_at = now() - interval '1 second'
    where s.run_id = test_run_id;
    submit_payload := public.api_submit_competitive_answer(
      student_a, test_run_id, qid, jsonb_build_object('type', 'numeric', 'value', key_val)
    );
  end loop;
  perform tests.ok((submit_payload->>'finished')::boolean = true, 'finite L1 pass finishes');
  select b.max_level_passed into max_passed
  from public.competitive_best b
  where b.student_id = student_a and b.topic_code = 'multiplication_table';
  perform tests.ok(max_passed >= 1, 'pass L1 unlocks');

  -- Super path
  insert into public.competitive_best (student_id, topic_code, best_score, best_duration_ms, attempt_count, max_level_passed)
  values (student_a, 'multiplication_table', 0, 0, 1, 5)
  on conflict (student_id, topic_code) do update set max_level_passed = 5;

  start_payload := public.api_start_competitive_run(student_a, 'multiplication_table', 6);
  test_run_id := (start_payload->>'runId')::uuid;
  qid := (start_payload->'question'->>'id')::uuid;
  perform tests.ok((start_payload->>'limitMs')::int = 8000, 'super start 8000');

  saw := false;
  begin
    perform public.api_submit_competitive_answer(
      student_a, test_run_id, qid, '{"type":"numeric","value":0}'::jsonb
    );
  exception when others then
    saw := sqlerrm ilike '%rate_limited%';
  end;
  perform tests.ok(saw, 'rate_limited when too fast');

  update private.competitive_run_state s
  set issued_at = now() - interval '1 second'
  where s.run_id = test_run_id;
  select (s.answer_key->>'value')::numeric into key_val
  from private.competitive_run_state s where s.run_id = test_run_id;
  submit_payload := public.api_submit_competitive_answer(
    student_a, test_run_id, qid, jsonb_build_object('type', 'numeric', 'value', key_val)
  );
  perform tests.ok(
    (submit_payload->>'finished')::boolean = false and (submit_payload->>'score')::int = 1,
    'super correct continues'
  );

  qid := (submit_payload->'question'->>'id')::uuid;
  update private.competitive_run_state s
  set issued_at = now() - interval '1 second'
  where s.run_id = test_run_id;
  submit_payload := public.api_submit_competitive_answer(
    student_a, test_run_id, qid, '{"type":"numeric","value":-99999}'::jsonb
  );
  perform tests.ok((submit_payload->>'finished')::boolean = true, 'super wrong finishes');
  perform tests.ok(
    jsonb_typeof(submit_payload->'result'->'qualified') = 'array',
    'qualified is array'
  );

  perform public.api_publish_competitive_result(student_a, test_run_id, 'nickname');

  insert into public.competitive_runs (
    id, student_id, topic_code, level_number, status, score, duration_ms, visibility, started_at, finished_at
  ) values (
    gen_random_uuid(), student_a, 'multiplication_table', 6, 'completed', 99, 1000, 'none',
    now() - interval '1 minute', now()
  );
  board := public.api_get_leaderboard(student_a, 'multiplication_table', 'class', 10, null);
  perform tests.ok(
    not exists (
      select 1 from jsonb_array_elements(board->'rows') e where (e->>'score')::int = 99
    ),
    'unpublished score 99 not on leaderboard'
  );
  perform tests.ok(
    exists (
      select 1 from jsonb_array_elements(board->'rows') e where (e->>'score')::int = 1
    ),
    'published score 1 on leaderboard'
  );

  board := public.api_get_leaderboard(student_b, 'multiplication_table', 'absolute', 10, null);
  perform tests.ok(
    not exists (
      select 1 from jsonb_array_elements(board->'rows') e where e->>'displayName' = 'g12b-sa'
    ),
    'grade 8 absolute excludes grade 7 row'
  );

  saw := false;
  begin
    perform public.api_get_competitive_results(teacher_b, class_a, 'multiplication_table');
  exception when others then
    saw := sqlerrm ilike '%not_found%';
  end;
  perform tests.ok(saw, 'teacher B not_found for class A');

  trev := public.api_get_competitive_results(teacher_a, class_a, 'multiplication_table');
  perform tests.ok(jsonb_array_length(trev->'rows') >= 1, 'teacher A sees class');

  perform tests.ok(true, '86_g12bc_competitive_run completed');
end;
$$;

rollback;

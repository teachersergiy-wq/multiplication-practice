-- G12d: qualified empty when worse than already-published Super run
begin;

do $$
declare
  student_a uuid := 'd12d0001-0000-4000-8000-0000000000c1';
  teacher_a uuid := 'd12d0001-0000-4000-8000-0000000000a1';
  school_id uuid;
  class_a uuid;
  subject_id uuid;
  start_payload jsonb;
  submit_payload jsonb;
  test_run_id uuid;
  qid uuid;
  key_val numeric;
  pub_run uuid;
begin
  perform tests.ensure_auth_user(student_a, 'g12d-sa@test.invalid');
  perform tests.ensure_auth_user(teacher_a, 'g12d-ta@test.invalid');

  insert into public.profiles (id, role, full_name, generated_nickname, student_login_code)
  values
    (teacher_a, 'teacher', 'G12d TA', 'g12d-ta', null),
    (student_a, 'student', 'G12d SA', 'g12d-sa', 'g12d')
  on conflict (id) do update set role = excluded.role, student_login_code = excluded.student_login_code;

  insert into public.schools (name) values ('G12d School') returning id into school_id;
  insert into public.classes (school_id, name) values (school_id, 'G12d-7') returning id into class_a;
  insert into public.class_teachers (class_id, teacher_id) values (class_a, teacher_a);
  insert into public.class_students (class_id, student_id) values (class_a, student_a);

  select id into subject_id from public.subjects where code = 'mathematics' limit 1;
  if subject_id is null then
    insert into public.subjects (code, title, active) values ('mathematics', 'Math', true)
    returning id into subject_id;
  end if;
  insert into public.class_subjects (class_id, subject_id, grade_level)
  values (class_a, subject_id, 7) on conflict do nothing;

  -- Unlock Super
  insert into public.competitive_best (student_id, topic_code, best_score, best_duration_ms, attempt_count, max_level_passed)
  values (student_a, 'multiplication_table', 50, 10000, 1, 5)
  on conflict (student_id, topic_code) do update set max_level_passed = 5, best_score = 50;

  -- Published strong run (score 50)
  insert into public.competitive_runs (
    id, student_id, topic_code, level_number, status, score, duration_ms, visibility, started_at, finished_at
  ) values (
    gen_random_uuid(), student_a, 'multiplication_table', 6, 'completed', 50, 10000, 'nickname',
    now() - interval '1 hour', now() - interval '50 minutes'
  )
  returning id into pub_run;

  -- New Super run that ends with score 1 (worse)
  start_payload := public.api_start_competitive_run(student_a, 'multiplication_table', 6);
  test_run_id := (start_payload->>'runId')::uuid;
  qid := (start_payload->'question'->>'id')::uuid;

  update private.competitive_run_state s
  set issued_at = now() - interval '1 second'
  where s.run_id = test_run_id;
  select (s.answer_key->>'value')::numeric into key_val
  from private.competitive_run_state s where s.run_id = test_run_id;

  submit_payload := public.api_submit_competitive_answer(
    student_a, test_run_id, qid, jsonb_build_object('type', 'numeric', 'value', key_val)
  );
  -- one correct then wrong
  qid := (submit_payload->'question'->>'id')::uuid;
  update private.competitive_run_state s
  set issued_at = now() - interval '1 second'
  where s.run_id = test_run_id;
  submit_payload := public.api_submit_competitive_answer(
    student_a, test_run_id, qid, '{"type":"numeric","value":-1}'::jsonb
  );

  perform tests.ok((submit_payload->>'finished')::boolean = true, 'worse run finished');
  perform tests.ok(
    jsonb_array_length(submit_payload->'result'->'qualified') = 0,
    'qualified empty when worse than published best'
  );

  perform tests.ok(true, '85_g12d_qualified_published_gate completed');
end;
$$;

rollback;

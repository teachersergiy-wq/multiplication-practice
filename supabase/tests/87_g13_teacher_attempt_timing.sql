-- G13: teacher attempt timing RPC
-- Review fixes: draft then publish; completed needs finished_at;
-- owner path via set_jwt; exception flags instead of tests.fail in WHEN OTHERS.
begin;

do $$
declare
  teacher_a uuid := 'a1300001-0000-4000-8000-0000000000a1';
  teacher_b uuid := 'a1300001-0000-4000-8000-0000000000b1';
  student_a uuid := 'a1300001-0000-4000-8000-0000000000c1';
  school_id uuid;
  class_a uuid;
  class_b uuid;
  subject_id uuid;
  template_id uuid;
  assignment_id uuid;
  attempt_id uuid;
  q1 uuid := 'a1300001-0000-4000-8000-0000000000d1';
  q2 uuid := 'a1300001-0000-4000-8000-0000000000d2';
  payload jsonb;
  secs1 numeric;
  secs2 numeric;
  saw_error boolean;
begin
  perform tests.ensure_auth_user(teacher_a, 'g13-ta@test.invalid');
  perform tests.ensure_auth_user(teacher_b, 'g13-tb@test.invalid');
  perform tests.ensure_auth_user(student_a, 'g13-sa@test.invalid');

  insert into public.profiles (id, role, full_name, generated_nickname, student_login_code)
  values
    (teacher_a, 'teacher', 'G13 TA', 'g13-ta', null),
    (teacher_b, 'teacher', 'G13 TB', 'g13-tb', null),
    (student_a, 'student', 'G13 SA', 'g13-sa', 'g13a')
  on conflict (id) do update set
    role = excluded.role,
    student_login_code = excluded.student_login_code;

  insert into public.schools (name) values ('G13 School') returning id into school_id;
  insert into public.classes (school_id, name) values (school_id, 'G13-A') returning id into class_a;
  insert into public.classes (school_id, name) values (school_id, 'G13-B') returning id into class_b;
  insert into public.class_teachers (class_id, teacher_id) values (class_a, teacher_a), (class_b, teacher_b);
  insert into public.class_students (class_id, student_id) values (class_a, student_a);

  select id into subject_id from public.subjects where code = 'mathematics' limit 1;
  if subject_id is null then
    insert into public.subjects (code, title, active)
    values ('mathematics', 'Mathematics', true)
    returning id into subject_id;
  end if;

  -- draft → questions → publish (published templates are frozen)
  insert into public.assessment_templates (id, teacher_id, subject_id, grade_level, title, status, mode)
  values (gen_random_uuid(), teacher_a, subject_id, 5, 'G13 Timing', 'draft', 'practice')
  returning id into template_id;

  insert into public.assessment_questions (id, template_id, position, question_type, prompt, points)
  values
    (q1, template_id, 1, 'numeric', '{"text":"2×3"}'::jsonb, 1),
    (q2, template_id, 2, 'numeric', '{"text":"4×5"}'::jsonb, 1);

  update public.assessment_templates
  set status = 'published'
  where id = template_id;

  insert into public.assessment_assignments (id, template_id, class_id, assigned_by)
  values (gen_random_uuid(), template_id, class_a, teacher_a)
  returning id into assignment_id;

  insert into public.assessment_attempts (
    id, assignment_id, student_id, status, started_at, finished_at
  )
  values (
    gen_random_uuid(), assignment_id, student_a, 'completed',
    timestamptz '2026-10-27 12:00:00+00',
    timestamptz '2026-10-27 12:00:15+00'
  )
  returning id into attempt_id;

  -- (1) Owner via set_jwt receives data (empty first)
  perform tests.set_jwt(teacher_a);
  payload := public.api_teacher_attempt_timing(teacher_a, attempt_id);
  perform tests.ok(
    jsonb_array_length(payload->'questions') = 0
      and payload->'summary'->>'avgSeconds' is null,
    'no responses → empty timing (jwt owner)'
  );
  perform tests.clear_jwt();

  insert into public.assessment_responses (attempt_id, question_id, response, is_correct, awarded_points, answered_at)
  values
    (attempt_id, q1, '{"type":"numeric","value":6}'::jsonb, true, 1,
     timestamptz '2026-10-27 12:00:05+00'),
    (attempt_id, q2, '{"type":"numeric","value":20}'::jsonb, true, 1,
     timestamptz '2026-10-27 12:00:12+00');

  -- (1) Owner with JWT sees deltas
  perform tests.set_jwt(teacher_a);
  payload := public.api_teacher_attempt_timing(teacher_a, attempt_id);
  secs1 := (payload->'questions'->0->>'answerSeconds')::numeric;
  secs2 := (payload->'questions'->1->>'answerSeconds')::numeric;

  perform tests.ok(secs1 = 5.00, format('first answer from started_at = 5s (got %s)', secs1));
  perform tests.ok(secs2 = 7.00, format('second answer delta = 7s (got %s)', secs2));
  perform tests.ok(
    (payload->'summary'->>'minSeconds')::numeric = 5.00
      and (payload->'summary'->>'maxSeconds')::numeric = 7.00,
    'summary min/max'
  );
  perform tests.ok(
    (payload->'summary'->>'avgSeconds')::numeric = 6.00,
    'summary avg'
  );
  perform tests.clear_jwt();

  -- (2) Other teacher → not_found
  perform tests.set_jwt(teacher_b);
  saw_error := false;
  begin
    perform public.api_teacher_attempt_timing(teacher_b, attempt_id);
  exception
    when others then
      saw_error := true;
      perform tests.ok(sqlerrm ilike '%not_found%', 'teacher B not_found: ' || sqlerrm);
  end;
  perform tests.ok(saw_error, 'teacher B must error');
  perform tests.clear_jwt();

  -- (3) Student → not_found (cannot impersonate teacher_a)
  perform tests.set_jwt(student_a);
  saw_error := false;
  begin
    perform public.api_teacher_attempt_timing(teacher_a, attempt_id);
  exception
    when others then
      saw_error := true;
      perform tests.ok(sqlerrm ilike '%not_found%', 'student not_found: ' || sqlerrm);
  end;
  perform tests.ok(saw_error, 'student must error');
  perform tests.clear_jwt();

  -- (4) anon no execute
  perform tests.ok(
    not has_function_privilege('anon', 'public.api_teacher_attempt_timing(uuid,uuid)', 'execute'),
    'anon cannot execute api_teacher_attempt_timing'
  );

  perform tests.ok(true, '87_g13_teacher_attempt_timing completed');
end;
$$;

rollback;

-- G12a: competitive schema exists; grants/RLS as specified; private state locked.
-- Filename must match supabase/tests/[0-9][0-9]_*.sql for CI.
begin;

do $$
declare
  teacher_a uuid := 'a12a0001-0000-4000-8000-0000000000a1';
  teacher_b uuid := 'a12a0001-0000-4000-8000-0000000000b1';
  student_a uuid := 'a12a0001-0000-4000-8000-0000000000c1';
  student_b uuid := 'a12a0001-0000-4000-8000-0000000000c2';
  school_id uuid;
  class_a uuid;
  class_b uuid;
  run_a uuid;
  run_b uuid;
begin
  perform tests.ensure_auth_user(teacher_a, 'g12a-ta@test.invalid');
  perform tests.ensure_auth_user(teacher_b, 'g12a-tb@test.invalid');
  perform tests.ensure_auth_user(student_a, 'g12a-sa@test.invalid');
  perform tests.ensure_auth_user(student_b, 'g12a-sb@test.invalid');

  insert into public.profiles (id, role, full_name, generated_nickname)
  values
    (teacher_a, 'teacher', 'G12a TA', 'g12a-ta'),
    (teacher_b, 'teacher', 'G12a TB', 'g12a-tb'),
    (student_a, 'student', 'G12a SA', 'g12a-sa'),
    (student_b, 'student', 'G12a SB', 'g12a-sb')
  on conflict (id) do update set role = excluded.role;

  insert into public.schools (name) values ('G12a School') returning id into school_id;
  insert into public.classes (school_id, name) values (school_id, 'G12a-A') returning id into class_a;
  insert into public.classes (school_id, name) values (school_id, 'G12a-B') returning id into class_b;
  insert into public.class_teachers (class_id, teacher_id) values (class_a, teacher_a), (class_b, teacher_b);
  insert into public.class_students (class_id, student_id) values (class_a, student_a), (class_b, student_b);

  perform tests.ok(
    exists (select 1 from public.competitive_topics where code = 'multiplication_table' and active),
    'seed topic multiplication_table active'
  );

  perform tests.ok(
    (select (settings->>'levelCount')::int from public.competitive_topics where code = 'multiplication_table') = 6,
    'multiplication_table levelCount = 6'
  );

  insert into public.competitive_runs (id, student_id, topic_code, level_number, status, score, started_at)
  values
    (gen_random_uuid(), student_a, 'multiplication_table', 6, 'in_progress', 0, now())
  returning id into run_a;

  insert into public.competitive_runs (id, student_id, topic_code, level_number, status, score, duration_ms, started_at, finished_at)
  values
    (gen_random_uuid(), student_b, 'multiplication_table', 6, 'completed', 12, 45000, now() - interval '1 minute', now())
  returning id into run_b;

  insert into public.competitive_best (student_id, topic_code, best_score, best_duration_ms, attempt_count, max_level_passed)
  values
    (student_a, 'multiplication_table', 0, 0, 1, 0),
    (student_b, 'multiplication_table', 12, 45000, 3, 5)
  on conflict do nothing;

  insert into private.competitive_run_state (run_id, question_id, prompt_text, answer_key, issued_at, limit_ms)
  values (run_a, gen_random_uuid(), '7 × 8', '{"value": 56}'::jsonb, now(), 7000);

  perform set_config('tests.g12a_teacher_a', teacher_a::text, true);
  perform set_config('tests.g12a_teacher_b', teacher_b::text, true);
  perform set_config('tests.g12a_student_a', student_a::text, true);
  perform set_config('tests.g12a_student_b', student_b::text, true);
  perform set_config('tests.g12a_run_a', run_a::text, true);
  perform set_config('tests.g12a_run_b', run_b::text, true);
end;
$$;

-- anon: no table privilege → must error
select tests.set_jwt('00000000-0000-4000-8000-000000000099'::uuid, 'anon');
select tests.throws(
  'select 1 from public.competitive_topics limit 1',
  'anon cannot select competitive_topics'
);
select tests.throws(
  'select 1 from public.competitive_runs limit 1',
  'anon cannot select competitive_runs'
);
select tests.throws(
  'select 1 from public.competitive_best limit 1',
  'anon cannot select competitive_best'
);

-- student A: topics + own run/best; not student B
select tests.set_jwt(current_setting('tests.g12a_student_a')::uuid);
select tests.ok(
  exists (select 1 from public.competitive_topics where code = 'multiplication_table'),
  'student can read active topics'
);
select tests.ok(
  exists (
    select 1 from public.competitive_runs
    where id = current_setting('tests.g12a_run_a')::uuid
  ),
  'student sees own run'
);
select tests.ok(
  not exists (
    select 1 from public.competitive_runs
    where id = current_setting('tests.g12a_run_b')::uuid
  ),
  'student does not see other student run'
);
select tests.ok(
  exists (
    select 1 from public.competitive_best
    where student_id = current_setting('tests.g12a_student_a')::uuid
  ),
  'student sees own best'
);
select tests.ok(
  not exists (
    select 1 from public.competitive_best
    where student_id = current_setting('tests.g12a_student_b')::uuid
  ),
  'student does not see other best'
);

select tests.throws(
  format(
    'insert into public.competitive_runs (student_id, topic_code, level_number) values (%L, ''multiplication_table'', 1)',
    current_setting('tests.g12a_student_a')
  ),
  'student cannot insert competitive_runs'
);

select tests.set_jwt(current_setting('tests.g12a_teacher_a')::uuid);
select tests.ok(
  exists (
    select 1 from public.competitive_runs
    where student_id = current_setting('tests.g12a_student_a')::uuid
  ),
  'teacher sees class student run'
);
select tests.ok(
  not exists (
    select 1 from public.competitive_runs
    where student_id = current_setting('tests.g12a_student_b')::uuid
  ),
  'teacher does not see other class run'
);

select tests.set_jwt(current_setting('tests.g12a_student_a')::uuid);
select tests.throws(
  format(
    'select prompt_text from private.competitive_run_state where run_id = %L',
    current_setting('tests.g12a_run_a')
  ),
  'authenticated cannot read private.competitive_run_state'
);

select tests.ok(
  not has_table_privilege('authenticated', 'public.competitive_runs', 'INSERT'),
  'authenticated lacks INSERT on competitive_runs'
);
select tests.ok(
  not has_table_privilege('authenticated', 'public.competitive_best', 'UPDATE'),
  'authenticated lacks UPDATE on competitive_best'
);
select tests.ok(
  not has_table_privilege('authenticated', 'public.competitive_topics', 'DELETE'),
  'authenticated lacks DELETE on competitive_topics'
);
select tests.ok(
  not has_table_privilege('authenticated', 'private.competitive_run_state', 'SELECT'),
  'authenticated lacks SELECT on private.competitive_run_state'
);

select tests.clear_jwt();
select tests.ok(true, '89_g12a_competitive_schema completed');
rollback;

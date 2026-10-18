-- G0: subjects visibility, template draft-only insert, multiplication configs RO.
begin;

-- Synthetic auth users (no real student data).
do $$
declare
  teacher_a uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  teacher_b uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  student_a uuid := 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  school_id uuid;
  class_a uuid;
  class_b uuid;
  subject_custom uuid;
  template_id uuid;
  assignment_id uuid;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
  values
    (teacher_a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'teacher-a@test.local', crypt('x', gen_salt('bf')), now(), now(), now()),
    (teacher_b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'teacher-b@test.local', crypt('x', gen_salt('bf')), now(), now(), now()),
    (student_a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'student-a@test.local', crypt('x', gen_salt('bf')), now(), now(), now())
  on conflict (id) do nothing;

  insert into public.profiles (id, role, full_name, generated_nickname, student_login_code)
  values
    (teacher_a, 'teacher', 'Teacher A', 'nick-ta', null),
    (teacher_b, 'teacher', 'Teacher B', 'nick-tb', null),
    (student_a, 'student', 'Student A', 'nick-sa', 'SA0001')
  on conflict (id) do nothing;

  insert into public.schools (name) values ('Test School G0') returning id into school_id;
  insert into public.classes (school_id, name) values (school_id, 'Class A') returning id into class_a;
  insert into public.classes (school_id, name) values (school_id, 'Class B') returning id into class_b;

  insert into public.class_teachers (class_id, teacher_id) values (class_a, teacher_a), (class_b, teacher_b);
  insert into public.class_students (student_id, class_id) values (student_a, class_a);

  insert into public.subjects (code, name, description, icon, is_system, created_by)
  values ('custom-g0', 'Custom G0', 'teacher owned', 'C', false, teacher_a)
  returning id into subject_custom;

  insert into public.class_subjects (class_id, subject_id, grade_level)
  values (class_a, subject_custom, 3);

  -- Teacher A creates a draft, then we publish via service path simulation (bypass RLS as postgres).
  insert into public.assessment_templates (id, teacher_id, subject_id, grade_level, title, status)
  values ('dddddddd-dddd-dddd-dddd-dddddddddddd', teacher_a, subject_custom, 3, 'G0 Test', 'draft');
  update public.assessment_templates set status = 'published' where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  template_id := 'dddddddd-dddd-dddd-dddd-dddddddddddd';

  insert into public.assessment_assignments (template_id, class_id, assigned_by)
  values (template_id, class_a, teacher_a)
  returning id into assignment_id;

  -- Store ids in session for later statements
  perform set_config('tests.teacher_a', teacher_a::text, true);
  perform set_config('tests.teacher_b', teacher_b::text, true);
  perform set_config('tests.student_a', student_a::text, true);
  perform set_config('tests.subject_custom', subject_custom::text, true);
  perform set_config('tests.class_a', class_a::text, true);
  perform set_config('tests.class_b', class_b::text, true);
  perform set_config('tests.template_id', template_id::text, true);
end;
$$;

-- Student can read teacher-created subject of assigned test.
select tests.set_jwt(current_setting('tests.student_a')::uuid);
select tests.ok(
  exists (
    select 1 from public.subjects s
    where s.id = current_setting('tests.subject_custom')::uuid
  ),
  'student reads custom subject of assigned test'
);

-- Teacher cannot modify multiplication_level_configs.
select tests.set_jwt(current_setting('tests.teacher_a')::uuid);
select tests.throws(
  format(
    'update public.multiplication_level_configs set pass_percent = 1 where subject_id = %L',
    (select id from public.subjects where code = 'mathematics')
  ),
  'teacher must not update multiplication_level_configs'
);

-- Insert template as published must be rejected by RLS.
select tests.set_jwt(current_setting('tests.teacher_a')::uuid);
select tests.throws(
  format(
    $q$
      insert into public.assessment_templates (teacher_id, subject_id, grade_level, title, status)
      values (%L, %L, 3, 'Should Fail', 'published')
    $q$,
    current_setting('tests.teacher_a'),
    current_setting('tests.subject_custom')
  ),
  'insert template with status=published must fail'
);

-- Draft insert allowed.
select tests.set_jwt(current_setting('tests.teacher_a')::uuid);
do $$
begin
  insert into public.assessment_templates (teacher_id, subject_id, grade_level, title, status)
  values (
    current_setting('tests.teacher_a')::uuid,
    current_setting('tests.subject_custom')::uuid,
    3,
    'Draft OK',
    'draft'
  );
exception
  when others then
    perform tests.fail('draft template insert should succeed: ' || sqlerrm);
end;
$$;

-- Client cannot insert into assessment_attempts.
select tests.set_jwt(current_setting('tests.student_a')::uuid);
select tests.throws(
  format(
    $q$
      insert into public.assessment_attempts (assignment_id, student_id)
      select id, %L from public.assessment_assignments limit 1
    $q$,
    current_setting('tests.student_a')
  ),
  'student insert assessment_attempts must fail'
);

select tests.clear_jwt();
select tests.ok(true, '20_policies_subjects_templates completed');

rollback;

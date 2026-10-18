-- G0: subjects visibility, draft-only template insert, multiplication configs RO.
begin;

do $$
declare
  teacher_a uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  teacher_b uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  student_a uuid := 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  school_id uuid;
  class_a uuid;
  class_b uuid;
  subject_custom uuid;
  subject_other uuid;
  template_id uuid;
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

  -- Subject owned by teacher B, not linked to student's class → student must not see it.
  insert into public.subjects (code, name, description, icon, is_system, created_by)
  values ('custom-g0-other', 'Other Custom', 'other teacher', 'O', false, teacher_b)
  returning id into subject_other;

  insert into public.class_subjects (class_id, subject_id, grade_level)
  values (class_a, subject_custom, 3);

  insert into public.assessment_templates (id, teacher_id, subject_id, grade_level, title, status)
  values ('dddddddd-dddd-dddd-dddd-dddddddddddd', teacher_a, subject_custom, 3, 'G0 Test', 'draft');
  update public.assessment_templates
    set status = 'published'
    where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  template_id := 'dddddddd-dddd-dddd-dddd-dddddddddddd';

  insert into public.assessment_assignments (template_id, class_id, assigned_by)
  values (template_id, class_a, teacher_a);

  perform set_config('tests.teacher_a', teacher_a::text, true);
  perform set_config('tests.teacher_b', teacher_b::text, true);
  perform set_config('tests.student_a', student_a::text, true);
  perform set_config('tests.subject_custom', subject_custom::text, true);
  perform set_config('tests.subject_other', subject_other::text, true);
  perform set_config('tests.class_a', class_a::text, true);
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

-- Student must not read unrelated custom subject from another teacher.
select tests.ok(
  not exists (
    select 1 from public.subjects s
    where s.id = current_setting('tests.subject_other')::uuid
  ),
  'student does not read unrelated custom subject'
);

-- Teacher cannot modify multiplication_level_configs (no policy + optional grant path).
-- Prefer zero-rows / error: after manage policy drop, UPDATE has no policy → RLS denies.
select tests.set_jwt(current_setting('tests.teacher_a')::uuid);
do $$
declare
  n integer;
  math_id uuid;
begin
  select id into math_id from public.subjects where code = 'mathematics' limit 1;
  update public.multiplication_level_configs
    set pass_percent = 1
    where subject_id = math_id;
  get diagnostics n = row_count;
  if n <> 0 then
    perform tests.fail(format('teacher must not update multiplication_level_configs (rows=%s)', n));
  end if;
exception
  when insufficient_privilege then
    null; -- also acceptable: no UPDATE grant
  when others then
    -- RLS denial may surface as different SQLSTATE depending on path
    if sqlerrm not like '%policy%' and sqlerrm not like '%permission%' then
      perform tests.fail('unexpected error updating multiplication_level_configs: ' || sqlerrm);
    end if;
end;
$$;

-- Insert template as published must be rejected (WITH CHECK).
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

-- Client cannot insert into assessment_attempts (no GRANT).
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

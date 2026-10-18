begin;
select tests.ok(not has_function_privilege('authenticated', 'private.publish_assessment(uuid)', 'execute'), 'authenticated cannot EXECUTE publish_assessment');
select tests.ok(not has_function_privilege('authenticated', 'private.finalize_attempt(uuid)', 'execute'), 'authenticated cannot EXECUTE finalize_attempt');
select tests.ok(not has_function_privilege('authenticated', 'private.create_student_records(uuid,text,text,uuid,text)', 'execute'), 'authenticated cannot EXECUTE create_student_records');
do $$
declare
  teacher_id uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa30';
  student_id uuid := 'cccccccc-cccc-cccc-cccc-cccccccccc30';
  subject_id uuid; school_id uuid; class_id uuid;
  template_id uuid := 'dddddddd-dddd-dddd-dddd-dddddddddd30';
  assignment_id uuid;
begin
  perform tests.ensure_auth_user(teacher_id, 'r5-t@test.local');
  perform tests.ensure_auth_user(student_id, 'r5-s@test.local');
  insert into public.profiles (id, role, full_name, generated_nickname, student_login_code) values
    (teacher_id, 'teacher', 'R5 T', 'r5-t', null),
    (student_id, 'student', 'R5 S', 'r5-s', 'R5ST01') on conflict (id) do nothing;
  insert into public.schools (name) values ('R5 School') returning id into school_id;
  insert into public.classes (school_id, name) values (school_id, 'R5') returning id into class_id;
  insert into public.class_teachers values (class_id, teacher_id);
  insert into public.class_students values (student_id, class_id);
  select id into subject_id from public.subjects where code = 'mathematics' limit 1;
  insert into public.assessment_templates (id, teacher_id, subject_id, grade_level, title, status)
  values (template_id, teacher_id, subject_id, 3, 'R5', 'published');
  insert into public.assessment_assignments (template_id, class_id, assigned_by)
  values (template_id, class_id, teacher_id) returning id into assignment_id;
  insert into public.assessment_attempts (assignment_id, student_id, status)
  values (assignment_id, student_id, 'in_progress');
  begin
    insert into public.assessment_attempts (assignment_id, student_id, status)
    values (assignment_id, student_id, 'in_progress');
    perform tests.fail('second in_progress attempt should fail unique index');
  exception when unique_violation then null;
  end;
  perform tests.ok(true, '60_r5_r6_r7 completed');
end;
$$;
rollback;

begin;
do $$
declare
  teacher_id uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa20';
  student_id uuid := 'cccccccc-cccc-cccc-cccc-cccccccccc20';
  subject_id uuid; school_id uuid; class_id uuid;
  template_id uuid := 'dddddddd-dddd-dddd-dddd-dddddddddd20';
  qid uuid;
begin
  perform tests.ensure_auth_user(teacher_id, 'r2-t@test.local');
  perform tests.ensure_auth_user(student_id, 'r2-s@test.local');
  insert into public.profiles (id, role, full_name, generated_nickname, student_login_code) values
    (teacher_id, 'teacher', 'R2 T', 'r2-t', null),
    (student_id, 'student', 'R2 S', 'r2-s', 'R2ST01') on conflict (id) do nothing;
  insert into public.schools (name) values ('R2 School') returning id into school_id;
  insert into public.classes (school_id, name) values (school_id, 'R2') returning id into class_id;
  insert into public.class_teachers values (class_id, teacher_id);
  insert into public.class_students values (student_id, class_id);
  select id into subject_id from public.subjects where code = 'mathematics' limit 1;
  insert into public.class_subjects values (class_id, subject_id, 3) on conflict do nothing;
  insert into public.assessment_templates (id, teacher_id, subject_id, grade_level, title, status)
  values (template_id, teacher_id, subject_id, 3, 'R2 draft', 'draft');
  insert into public.assessment_questions (template_id, position, question_type, prompt)
  values (template_id, 1, 'numeric', '{"text":"1+1"}'::jsonb) returning id into qid;
  perform set_config('tests.teacher_id', teacher_id::text, true);
  perform set_config('tests.student_id', student_id::text, true);
  perform set_config('tests.template_id', template_id::text, true);
  perform set_config('tests.qid', qid::text, true);
end;
$$;
select tests.set_jwt(current_setting('tests.student_id')::uuid);
select tests.ok(not exists (select 1 from public.assessment_questions q where q.id = current_setting('tests.qid')::uuid), 'student cannot read assessment_questions');
select tests.set_jwt(current_setting('tests.teacher_id')::uuid);
select tests.throws(format($q$ insert into public.assessment_questions (template_id, position, question_type, prompt) values (%L, 2, 'numeric', '{}'::jsonb) $q$, current_setting('tests.template_id')), 'teacher cannot insert assessment_questions directly');
select tests.updates_zero_rows(format('update public.assessment_templates set status = ''published'' where id = %L', current_setting('tests.template_id')), 'client cannot set status=published');
select tests.clear_jwt();
select tests.ok(exists (select 1 from public.assessment_templates where id = current_setting('tests.template_id')::uuid and status = 'draft'), 'template remains draft');
rollback;

-- G7 (issue #53): create-class / set-class-subject bounds, isolation, duplicates.
begin;

do $$
declare
  teacher_a uuid := 'a7a7a7a7-a7a7-a7a7-a7a7-a7a7a7a7a701';
  teacher_b uuid := 'b7b7b7b7-b7b7-b7b7-b7b7-b7b7b7b7b701';
  school_a uuid;
  school_b uuid;
  class_a uuid;
  class_b uuid;
  subject_id uuid;
  subject_uk uuid;
  tpl uuid := 'e7e7e7e7-e7e7-e7e7-e7e7-e7e7e7e7e701';
begin
  perform tests.ensure_auth_user(teacher_a, 'g7-a@test.local');
  perform tests.ensure_auth_user(teacher_b, 'g7-b@test.local');

  insert into public.profiles (id, role, full_name, generated_nickname)
  values
    (teacher_a, 'teacher', 'G7 A', 'g7-teacher-a'),
    (teacher_b, 'teacher', 'G7 B', 'g7-teacher-b')
  on conflict (id) do nothing;

  insert into public.schools (name) values ('G7 School A') returning id into school_a;
  insert into public.schools (name) values ('G7 School B') returning id into school_b;
  insert into public.classes (school_id, name) values (school_a, '8') returning id into class_a;
  insert into public.classes (school_id, name) values (school_b, '8') returning id into class_b;
  insert into public.class_teachers (class_id, teacher_id)
  values (class_a, teacher_a), (class_b, teacher_b);

  select id into subject_id from public.subjects where code = 'mathematics' limit 1;
  select id into subject_uk from public.subjects where code = 'ukrainian-language' limit 1;

  insert into public.class_subjects (class_id, subject_id, grade_level)
  values (class_a, subject_id, 8)
  on conflict do nothing;

  insert into public.assessment_templates (id, teacher_id, subject_id, grade_level, title, mode, status)
  values (tpl, teacher_a, subject_id, 8, 'G7 published', 'graded', 'published');

  insert into public.assessment_assignments (template_id, class_id, assigned_by)
  values (tpl, class_a, teacher_a);

  perform set_config('tests.g7.teacher_a', teacher_a::text, true);
  perform set_config('tests.g7.teacher_b', teacher_b::text, true);
  perform set_config('tests.g7.class_a', class_a::text, true);
  perform set_config('tests.g7.class_b', class_b::text, true);
  perform set_config('tests.g7.subject', subject_id::text, true);
  perform set_config('tests.g7.subject_uk', subject_uk::text, true);
end;
$$;

-- Happy path: create class with subject + grade
select tests.ok(
  (public.api_create_class(
    current_setting('tests.g7.teacher_a')::uuid,
    '9-A',
    current_setting('tests.g7.subject')::uuid,
    9
  )->>'name') = '9-A',
  'api_create_class creates named class'
);

select tests.ok(
  exists (
    select 1
    from public.classes c
    join public.class_teachers ct on ct.class_id = c.id
    join public.class_subjects cs on cs.class_id = c.id
    where ct.teacher_id = current_setting('tests.g7.teacher_a')::uuid
      and c.name = '9-A'
      and cs.subject_id = current_setting('tests.g7.subject')::uuid
      and cs.grade_level = 9
  ),
  'class_teachers and class_subjects rows exist after create'
);

-- Bounds: empty name, grade out of range
select tests.throws(
  format(
    $q$ select public.api_create_class(%L::uuid, '', %L::uuid, 5) $q$,
    current_setting('tests.g7.teacher_a'),
    current_setting('tests.g7.subject')
  ),
  'empty name rejected'
);

select tests.throws(
  format(
    $q$ select public.api_create_class(%L::uuid, 'ok', %L::uuid, 0) $q$,
    current_setting('tests.g7.teacher_a'),
    current_setting('tests.g7.subject')
  ),
  'gradeLevel 0 rejected'
);

select tests.throws(
  format(
    $q$ select public.api_create_class(%L::uuid, 'ok', %L::uuid, 13) $q$,
    current_setting('tests.g7.teacher_a'),
    current_setting('tests.g7.subject')
  ),
  'gradeLevel 13 rejected'
);

-- Duplicate name in same school
select tests.throws(
  format(
    $q$ select public.api_create_class(%L::uuid, '8', %L::uuid, 8) $q$,
    current_setting('tests.g7.teacher_a'),
    current_setting('tests.g7.subject')
  ),
  'duplicate class name in school rejected'
);

-- Foreign teacher cannot set subject on another teacher's class
select tests.throws(
  format(
    $q$ select public.api_set_class_subject(%L::uuid, %L::uuid, %L::uuid, 8) $q$,
    current_setting('tests.g7.teacher_b'),
    current_setting('tests.g7.class_a'),
    current_setting('tests.g7.subject_uk')
  ),
  'teacher B cannot set subject on teacher A class'
);

-- set-class-subject: add second subject
select tests.ok(
  (public.api_set_class_subject(
    current_setting('tests.g7.teacher_a')::uuid,
    current_setting('tests.g7.class_a')::uuid,
    current_setting('tests.g7.subject_uk')::uuid,
    8
  )->>'created')::boolean = true,
  'api_set_class_subject adds a new subject'
);

-- Idempotent same grade
select tests.ok(
  (public.api_set_class_subject(
    current_setting('tests.g7.teacher_a')::uuid,
    current_setting('tests.g7.class_a')::uuid,
    current_setting('tests.g7.subject_uk')::uuid,
    8
  )->>'created')::boolean = false,
  'api_set_class_subject is idempotent for same grade'
);

-- Change grade forbidden when assignments exist for subject
select tests.throws(
  format(
    $q$ select public.api_set_class_subject(%L::uuid, %L::uuid, %L::uuid, 7) $q$,
    current_setting('tests.g7.teacher_a'),
    current_setting('tests.g7.class_a'),
    current_setting('tests.g7.subject')
  ),
  'cannot change gradeLevel while assignments exist for subject'
);

-- Client roles cannot execute the RPCs
set local role authenticated;
select tests.throws(
  format(
    $q$ select public.api_create_class(%L::uuid, 'x', %L::uuid, 5) $q$,
    current_setting('tests.g7.teacher_a'),
    current_setting('tests.g7.subject')
  ),
  'authenticated cannot execute api_create_class'
);
select tests.throws(
  format(
    $q$ select public.api_set_class_subject(%L::uuid, %L::uuid, %L::uuid, 5) $q$,
    current_setting('tests.g7.teacher_a'),
    current_setting('tests.g7.class_a'),
    current_setting('tests.g7.subject')
  ),
  'authenticated cannot execute api_set_class_subject'
);
reset role;

select tests.ok(true, '94_g7_create_class completed');

rollback;

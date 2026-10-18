-- G0: teacher A must not see or modify teacher B templates/classes.
begin;

do $$
declare
  teacher_a uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01';
  teacher_b uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb01';
  school_id uuid;
  class_a uuid;
  class_b uuid;
  subject_id uuid;
  template_b uuid := 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee01';
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
  values
    (teacher_a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'iso-a@test.local', crypt('x', gen_salt('bf')), now(), now(), now()),
    (teacher_b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'iso-b@test.local', crypt('x', gen_salt('bf')), now(), now(), now())
  on conflict (id) do nothing;

  insert into public.profiles (id, role, full_name, generated_nickname)
  values
    (teacher_a, 'teacher', 'Iso A', 'iso-a'),
    (teacher_b, 'teacher', 'Iso B', 'iso-b')
  on conflict (id) do nothing;

  insert into public.schools (name) values ('Iso School') returning id into school_id;
  insert into public.classes (school_id, name) values (school_id, 'Iso A') returning id into class_a;
  insert into public.classes (school_id, name) values (school_id, 'Iso B') returning id into class_b;
  insert into public.class_teachers (class_id, teacher_id) values (class_a, teacher_a), (class_b, teacher_b);

  select id into subject_id from public.subjects where code = 'mathematics' limit 1;

  insert into public.class_subjects (class_id, subject_id, grade_level)
  values (class_b, subject_id, 3)
  on conflict do nothing;

  insert into public.assessment_templates (id, teacher_id, subject_id, grade_level, title, status)
  values (template_b, teacher_b, subject_id, 3, 'B private draft', 'draft');

  perform set_config('tests.teacher_a', teacher_a::text, true);
  perform set_config('tests.teacher_b', teacher_b::text, true);
  perform set_config('tests.class_b', class_b::text, true);
  perform set_config('tests.template_b', template_b::text, true);
  perform set_config('tests.template_b_title', 'B private draft', true);
end;
$$;

-- Teacher A cannot see teacher B template.
select tests.set_jwt(current_setting('tests.teacher_a')::uuid);
select tests.ok(
  not exists (
    select 1 from public.assessment_templates t
    where t.id = current_setting('tests.template_b')::uuid
  ),
  'teacher A does not see teacher B template'
);

-- Teacher A UPDATE on B template is silently denied by RLS (0 rows), not an exception.
select tests.updates_zero_rows(
  format(
    'update public.assessment_templates set title = ''hacked'' where id = %L',
    current_setting('tests.template_b')
  ),
  'teacher A must not update teacher B template'
);

-- Confirm title unchanged as postgres.
select tests.clear_jwt();
select tests.ok(
  exists (
    select 1 from public.assessment_templates t
    where t.id = current_setting('tests.template_b')::uuid
      and t.title = 'B private draft'
  ),
  'teacher B template title unchanged after A update attempt'
);

-- Teacher A cannot manage teacher B class_subjects (WITH CHECK / USING fail → error).
select tests.set_jwt(current_setting('tests.teacher_a')::uuid);
select tests.throws(
  format(
    $q$
      insert into public.class_subjects (class_id, subject_id, grade_level)
      select %L, id, 4 from public.subjects where code = 'mathematics' limit 1
    $q$,
    current_setting('tests.class_b')
  ),
  'teacher A must not insert class_subjects for class B'
);

select tests.clear_jwt();
select tests.ok(true, '30_teacher_isolation completed');

rollback;

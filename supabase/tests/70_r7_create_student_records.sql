-- R7: create_student_records is not executable by authenticated; works as postgres/service.
begin;

do $$
declare
  teacher_id uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa70';
  student_id uuid := 'cccccccc-cccc-cccc-cccc-cccccccccc70';
  school_id uuid;
  class_id uuid;
begin
  perform tests.ensure_auth_user(teacher_id, 'g2-t@test.local');
  perform tests.ensure_auth_user(student_id, 'g2-s@test.local');

  insert into public.profiles (id, role, full_name, generated_nickname)
  values (teacher_id, 'teacher', 'G2 T', 'g2-t')
  on conflict (id) do nothing;

  insert into public.schools (name) values ('G2 School') returning id into school_id;
  insert into public.classes (school_id, name) values (school_id, 'G2') returning id into class_id;
  insert into public.class_teachers values (class_id, teacher_id);

  -- As postgres (migration owner path / service): function should insert
  perform private.create_student_records(
    student_id,
    'Student G2',
    'abcd',
    class_id,
    'Учень-abcd'
  );

  perform tests.ok(
    exists (
      select 1 from public.profiles p
      where p.id = student_id and p.role = 'student' and p.student_login_code = 'abcd'
    ),
    'create_student_records inserts profile'
  );
  perform tests.ok(
    exists (
      select 1 from public.class_students cs
      where cs.student_id = student_id and cs.class_id = class_id
    ),
    'create_student_records links class'
  );

  perform tests.set_jwt(teacher_id);
  begin
    perform private.create_student_records(
      'dddddddd-dddd-dddd-dddd-dddddddddd70',
      'Nope',
      'efgh',
      class_id,
      'x'
    );
    perform tests.fail('authenticated must not execute create_student_records');
  exception
    when insufficient_privilege then null;
    when others then
      if sqlerrm not like '%permission%' and sqlerrm not like '%denied%' then
        perform tests.fail('unexpected: ' || sqlerrm);
      end if;
  end;

  perform tests.clear_jwt();
  perform tests.ok(true, '70_r7_create_student_records completed');
end;
$$;

rollback;

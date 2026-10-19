begin;
do $$
declare
  test_teacher_id uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa70';
  test_student_id uuid := 'cccccccc-cccc-cccc-cccc-cccccccccc70';
  test_school_id uuid;
  test_class_id uuid;
begin
  perform tests.ensure_auth_user(test_teacher_id, 'g2-t@test.local');
  perform tests.ensure_auth_user(test_student_id, 'g2-s@test.local');
  insert into public.profiles (id, role, full_name, generated_nickname)
  values (test_teacher_id, 'teacher', 'G2 T', 'g2-t') on conflict (id) do nothing;
  insert into public.schools (name) values ('G2 School') returning id into test_school_id;
  insert into public.classes (school_id, name) values (test_school_id, 'G2') returning id into test_class_id;
  insert into public.class_teachers values (test_class_id, test_teacher_id);
  perform private.create_student_records(test_student_id, 'Student G2', 'abcd', test_class_id, 'Учень-abcd');
  perform tests.ok(
    exists (
      select 1 from public.profiles p
      where p.id = test_student_id and p.role = 'student' and p.student_login_code = 'abcd'
    ),
    'create_student_records inserts profile'
  );
  perform tests.ok(
    exists (
      select 1 from public.class_students cs
      where cs.student_id = test_student_id and cs.class_id = test_class_id
    ),
    'create_student_records links class'
  );
  perform tests.set_jwt(test_teacher_id);
  begin
    perform private.create_student_records(
      'dddddddd-dddd-dddd-dddd-dddddddddd70', 'Nope', 'efgh', test_class_id, 'x'
    );
    perform tests.fail('authenticated must not execute create_student_records');
  exception when insufficient_privilege then null;
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

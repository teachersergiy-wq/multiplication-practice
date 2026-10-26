-- G10: teacher admin RPCs and grants.
begin;

select tests.ok(
  not has_function_privilege('authenticated', 'public.api_admin_require(uuid)', 'execute'),
  'authenticated no execute api_admin_require'
);
select tests.ok(
  not has_function_privilege('anon', 'public.api_admin_list_teachers(uuid)', 'execute'),
  'anon no execute list'
);
select tests.ok(
  not has_function_privilege(
    'authenticated',
    'public.api_admin_register_teacher(uuid,uuid,text,text)',
    'execute'
  ),
  'authenticated no execute register'
);
select tests.ok(
  has_function_privilege('service_role', 'public.api_admin_list_teachers(uuid)', 'execute'),
  'service_role can list'
);

do $$
declare
  admin_id uuid := 'b0b0b0b0-b0b0-b0b0-b0b0-b0b0b0b0b001';
  teacher_id uuid := 'b0b0b0b0-b0b0-b0b0-b0b0-b0b0b0b0b002';
  student_id uuid := 'b0b0b0b0-b0b0-b0b0-b0b0-b0b0b0b0b003';
  other_admin uuid := 'b0b0b0b0-b0b0-b0b0-b0b0-b0b0b0b0b004';
  res jsonb;
  n int;
begin
  perform tests.ensure_auth_user(admin_id, 'g10-admin@test.local');
  perform tests.ensure_auth_user(teacher_id, 'g10-teacher@test.local');
  perform tests.ensure_auth_user(student_id, 'g10-student@test.local');
  perform tests.ensure_auth_user(other_admin, 'g10-admin2@test.local');

  insert into private.admin_users (user_id) values (admin_id)
  on conflict do nothing;
  insert into private.admin_users (user_id) values (other_admin)
  on conflict do nothing;

  -- Non-admin teacher rejected
  begin
    perform public.api_admin_require(teacher_id);
    perform tests.fail('teacher should not be admin');
  exception when others then
    perform tests.ok(sqlerrm ilike '%forbidden%', 'teacher forbidden');
  end;

  begin
    perform public.api_admin_require(student_id);
    perform tests.fail('student should not be admin');
  exception when others then
    perform tests.ok(sqlerrm ilike '%forbidden%', 'student forbidden');
  end;

  perform public.api_admin_require(admin_id);
  perform tests.ok(true, 'admin require ok');

  -- Register teacher (Auth user already exists from ensure_auth_user)
  res := public.api_admin_register_teacher(
    admin_id, teacher_id, 'g10-teacher@test.local', 'G10 Teacher'
  );
  perform tests.ok((res->>'userId')::uuid = teacher_id, 'register userId');
  perform tests.ok((res->>'hasProfile')::boolean = true, 'has profile');
  perform tests.ok(
    exists (select 1 from private.allowed_teachers where email = 'g10-teacher@test.local'),
    'allowlist row'
  );
  perform tests.ok(
    exists (
      select 1 from public.profiles p
      join public.class_teachers ct on ct.teacher_id = p.id
      where p.id = teacher_id and p.role = 'teacher'
    ),
    'profile and class link'
  );
  perform tests.ok(
    exists (
      select 1 from private.admin_audit a
      where a.actor = admin_id and a.action = 'add_teacher' and a.target = teacher_id
    ),
    'audit add_teacher'
  );

  -- Conflict on second allowlist
  begin
    perform public.api_admin_register_teacher(
      admin_id, teacher_id, 'g10-teacher@test.local', 'Again'
    );
    perform tests.fail('duplicate should conflict');
  exception when others then
    perform tests.ok(sqlerrm ilike '%conflict%', 'duplicate conflict');
  end;

  -- Cannot manage self
  begin
    perform public.api_admin_assert_manage_teacher(admin_id, admin_id, false);
    perform tests.fail('self manage should fail');
  exception when others then
    perform tests.ok(sqlerrm ilike '%invalid_request%', 'self invalid_request');
  end;

  -- Cannot set-active on admin
  begin
    perform public.api_admin_assert_manage_teacher(admin_id, other_admin, true);
    perform tests.fail('admin target should fail');
  exception when others then
    perform tests.ok(sqlerrm ilike '%forbidden%', 'admin target forbidden');
  end;

  res := public.api_admin_list_teachers(admin_id);
  perform tests.ok(jsonb_typeof(res->'teachers') = 'array', 'list is array');
  select count(*) into n
  from jsonb_array_elements(res->'teachers') t
  where t->>'email' = 'g10-teacher@test.local';
  perform tests.ok(n >= 1, 'list contains new teacher');
  perform tests.ok(
    not exists (
      select 1 from jsonb_array_elements(res->'teachers') t
      where t ? 'temporaryPassword' or t ? 'password'
    ),
    'list has no passwords'
  );

  -- private tables: no privileges for browser roles
  perform tests.ok(
    not has_table_privilege('authenticated', 'private.admin_users', 'select'),
    'authenticated cannot select admin_users'
  );
  perform tests.ok(
    not has_table_privilege('anon', 'private.admin_audit', 'select'),
    'anon cannot select admin_audit'
  );
end;
$$;

select tests.ok(true, '98_g10_teacher_admin completed');
rollback;

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
  v_admin_id uuid := 'b0b0b0b0-b0b0-b0b0-b0b0-b0b0b0b0b001';
  v_teacher_id uuid := 'b0b0b0b0-b0b0-b0b0-b0b0-b0b0b0b0b002';
  v_student_id uuid := 'b0b0b0b0-b0b0-b0b0-b0b0-b0b0b0b0b003';
  v_other_admin uuid := 'b0b0b0b0-b0b0-b0b0-b0b0-b0b0b0b0b004';
  res jsonb;
  n int;
begin
  perform tests.ensure_auth_user(v_admin_id, 'g10-admin@test.local');
  perform tests.ensure_auth_user(v_teacher_id, 'g10-teacher@test.local');
  perform tests.ensure_auth_user(v_student_id, 'g10-student@test.local');
  perform tests.ensure_auth_user(v_other_admin, 'g10-admin2@test.local');

  insert into private.admin_users (user_id) values (v_admin_id)
  on conflict do nothing;
  insert into private.admin_users (user_id) values (v_other_admin)
  on conflict do nothing;

  -- Student profile (no teacher)
  insert into public.profiles (id, role, full_name, generated_nickname, student_login_code)
  values (v_student_id, 'student', 'G10 Student', 'G10STUD', 'g10s')
  on conflict (id) do nothing;

  begin
    perform public.api_admin_require(v_teacher_id);
    perform tests.fail('teacher should not be admin');
  exception when others then
    perform tests.ok(sqlerrm ilike '%forbidden%', 'teacher forbidden');
  end;

  begin
    perform public.api_admin_require(v_student_id);
    perform tests.fail('student should not be admin');
  exception when others then
    perform tests.ok(sqlerrm ilike '%forbidden%', 'student forbidden');
  end;

  perform public.api_admin_require(v_admin_id);
  perform tests.ok(true, 'admin require ok');

  res := public.api_admin_register_teacher(
    v_admin_id, v_teacher_id, 'g10-teacher@test.local', 'G10 Teacher'
  );
  perform tests.ok((res->>'userId')::uuid = v_teacher_id, 'register userId');
  perform tests.ok((res->>'hasProfile')::boolean = true, 'has profile');
  perform tests.ok(
    exists (select 1 from private.allowed_teachers where email = 'g10-teacher@test.local'),
    'allowlist row'
  );
  perform tests.ok(
    exists (
      select 1 from public.profiles p
      join public.class_teachers ct on ct.teacher_id = p.id
      where p.id = v_teacher_id and p.role = 'teacher'
    ),
    'profile and class link'
  );
  perform tests.ok(
    exists (
      select 1 from private.admin_audit a
      where a.actor = v_admin_id and a.action = 'add_teacher' and a.target = v_teacher_id
    ),
    'audit add_teacher'
  );

  begin
    perform public.api_admin_register_teacher(
      v_admin_id, v_teacher_id, 'g10-teacher@test.local', 'Again'
    );
    perform tests.fail('duplicate should conflict');
  exception when others then
    perform tests.ok(sqlerrm ilike '%conflict%', 'duplicate conflict');
  end;

  begin
    perform public.api_admin_assert_manage_teacher(v_admin_id, v_admin_id, false);
    perform tests.fail('self manage should fail');
  exception when others then
    perform tests.ok(sqlerrm ilike '%invalid_request%', 'self invalid_request');
  end;

  -- Student must not be reset/deactivated
  begin
    perform public.api_admin_assert_manage_teacher(v_admin_id, v_student_id, false);
    perform tests.fail('student target should fail');
  exception when others then
    perform tests.ok(sqlerrm ilike '%not a teacher%', 'student target forbidden');
  end;

  begin
    perform public.api_admin_assert_manage_teacher(v_admin_id, v_other_admin, true);
    perform tests.fail('admin target should fail');
  exception when others then
    -- other_admin has no teacher profile → not_found or not a teacher;
    -- if later given teacher+admin, forbid_admin still blocks.
    perform tests.ok(
      sqlerrm ilike '%forbidden%' or sqlerrm ilike '%not_found%' or sqlerrm ilike '%not a teacher%',
      'admin target blocked'
    );
  end;

  -- Teacher target allowed
  perform public.api_admin_assert_manage_teacher(v_admin_id, v_teacher_id, true);
  perform tests.ok(true, 'teacher target ok');

  res := public.api_admin_list_teachers(v_admin_id);
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

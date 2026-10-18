-- Public API wrappers: only service_role may execute; private not required via PostgREST.
begin;

select tests.ok(
  exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'api_is_allowed_teacher'
  ),
  'public.api_is_allowed_teacher exists'
);

select tests.ok(
  exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'api_provision_teacher'
  ),
  'public.api_provision_teacher exists'
);

-- Seed allowlist as postgres
insert into private.allowed_teachers (email, note)
values ('allowed-g1@test.local', 'test')
on conflict (email) do nothing;

select tests.ok(
  public.api_is_allowed_teacher('allowed-g1@test.local') = true,
  'allowlist hit as definer'
);
select tests.ok(
  public.api_is_allowed_teacher('nope@test.local') = false,
  'allowlist miss'
);

-- authenticated cannot execute
do $$
declare
  teacher_id uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa65';
begin
  perform tests.ensure_auth_user(teacher_id, 'wrap-t@test.local');
  perform tests.set_jwt(teacher_id);
  begin
    perform public.api_is_allowed_teacher('x@y.z');
    perform tests.fail('authenticated must not execute api_is_allowed_teacher');
  exception
    when insufficient_privilege then null;
    when others then
      if sqlerrm not like '%permission%' and sqlerrm not like '%denied%' then
        perform tests.fail('unexpected: ' || sqlerrm);
      end if;
  end;
  begin
    perform public.api_provision_teacher(
      teacher_id, 'Name', 'School', 'Class'
    );
    perform tests.fail('authenticated must not execute api_provision_teacher');
  exception
    when insufficient_privilege then null;
    when others then
      if sqlerrm not like '%permission%' and sqlerrm not like '%denied%' then
        perform tests.fail('unexpected provision: ' || sqlerrm);
      end if;
  end;
  perform tests.clear_jwt();
end;
$$;

-- Atomic provision as postgres/service path
do $$
declare
  uid uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa66';
  result jsonb;
begin
  perform tests.ensure_auth_user(uid, 'allowed-g1@test.local');
  result := public.api_provision_teacher(uid, 'Teacher Wrap', 'School W', 'Class W');
  perform tests.ok((result->>'created')::boolean = true, 'first provision creates');
  perform tests.ok(result ? 'profileId', 'has profileId');
  perform tests.ok(result ? 'schoolId', 'has schoolId');
  perform tests.ok(result ? 'classId', 'has classId');

  result := public.api_provision_teacher(uid, 'Ignored', 'X', 'Y');
  perform tests.ok((result->>'created')::boolean = false, 'second provision idempotent');
end;
$$;

select tests.ok(true, '65_public_api_wrappers completed');
rollback;

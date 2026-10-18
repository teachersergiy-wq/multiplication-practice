-- Public API wrappers: only service_role may execute; privilege catalog checks + runtime.
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

-- Catalog: authenticated must not have EXECUTE
select tests.ok(
  not has_function_privilege(
    'authenticated',
    'public.api_is_allowed_teacher(text)',
    'execute'
  ),
  'authenticated lacks EXECUTE on api_is_allowed_teacher'
);

select tests.ok(
  not has_function_privilege(
    'authenticated',
    'public.api_provision_teacher(uuid,text,text,text)',
    'execute'
  ),
  'authenticated lacks EXECUTE on api_provision_teacher'
);

select tests.ok(
  not has_function_privilege(
    'anon',
    'public.api_is_allowed_teacher(text)',
    'execute'
  ),
  'anon lacks EXECUTE on api_is_allowed_teacher'
);

-- Runtime as definer/owner path (postgres in CI)
insert into private.allowed_teachers (email, note)
values ('allowed-g1@test.local', 'test')
on conflict (email) do nothing;

select tests.ok(
  public.api_is_allowed_teacher('allowed-g1@test.local') = true,
  'allowlist hit as migration owner'
);
select tests.ok(
  public.api_is_allowed_teacher('nope@test.local') = false,
  'allowlist miss'
);

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

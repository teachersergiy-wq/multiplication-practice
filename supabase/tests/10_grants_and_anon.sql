-- G0: grants, anon lockdown, attempts/responses write deny, answer keys.
-- Depends on 00_helpers.sql (run first by name order in CI).

begin;

select tests.ok(
  not exists (
    select 1
    from information_schema.role_table_grants g
    where g.grantee = 'anon'
      and g.table_schema = 'public'
      and g.privilege_type in (
        'SELECT', 'INSERT', 'UPDATE', 'DELETE',
        'TRUNCATE', 'REFERENCES', 'TRIGGER'
      )
  ),
  'anon has no DML/TRUNCATE/TRIGGER/REFERENCES on public tables'
);

select tests.ok(
  not exists (
    select 1
    from information_schema.role_table_grants g
    where g.grantee = 'authenticated'
      and g.table_schema = 'public'
      and g.privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER')
  ),
  'authenticated has no TRUNCATE/TRIGGER/REFERENCES on public tables'
);

select tests.ok(
  not exists (
    select 1
    from information_schema.role_table_grants g
    where g.grantee in ('anon', 'authenticated')
      and g.table_schema = 'public'
      and g.table_name in ('assessment_attempts', 'assessment_responses')
      and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE')
  ),
  'client roles cannot write assessment_attempts or assessment_responses'
);

select tests.ok(
  not exists (
    select 1
    from information_schema.role_table_grants g
    where g.grantee in ('anon', 'authenticated', 'public')
      and g.table_schema = 'private'
      and g.table_name = 'assessment_answer_keys'
  ),
  'private.assessment_answer_keys has no grants to anon/authenticated/public'
);

-- Runtime: anon has no SELECT/INSERT privilege → must error (not silent empty).
set local role anon;
select tests.throws(
  'select count(*) from public.subjects',
  'anon select subjects must fail'
);
select tests.throws(
  'insert into public.subjects(code, name) values (''x'', ''x'')',
  'anon insert subjects must fail'
);
select tests.throws(
  'select count(*) from private.assessment_answer_keys',
  'anon select answer keys must fail'
);
reset role;

select tests.ok(true, '10_grants_and_anon completed');

rollback;

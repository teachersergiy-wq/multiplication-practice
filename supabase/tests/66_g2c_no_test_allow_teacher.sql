begin;

-- G2c: after migration 20261020000100 the test helper must not exist in the schema.
select tests.ok(
  not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = '_test_allow_teacher'
  ),
  'public._test_allow_teacher must not exist after G2c migration'
);

select tests.ok(true, '66_g2c_no_test_allow_teacher completed');
rollback;

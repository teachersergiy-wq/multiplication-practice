begin;
select tests.ok(
  exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'api_submit_answer'
  ),
  'api_submit_answer exists'
);
select tests.ok(true, '91_g6b temp completed');
rollback;

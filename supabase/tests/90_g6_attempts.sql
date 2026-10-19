begin;

select tests.ok(
  exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='api_start_attempt'),
  'api_start_attempt exists'
);
select tests.ok(
  not has_function_privilege('authenticated', 'public.api_start_attempt(uuid,uuid)', 'execute'),
  'authenticated cannot start_attempt'
);
select tests.ok(
  has_function_privilege('service_role', 'public.api_finish_attempt(uuid,uuid)', 'execute'),
  'service_role can finish'
);

-- Scoring unit checks
select tests.ok(
  (select is_correct from private.score_response(
    'true_false', '{"type":"true_false","value":true}'::jsonb,
    '{"type":"true_false","value":true}'::jsonb, 2
  )) = true,
  'true_false correct'
);
select tests.ok(
  (select awarded_points from private.score_response(
    'true_false', '{"type":"true_false","value":true}'::jsonb,
    '{"type":"true_false","value":false}'::jsonb, 2
  )) = 0,
  'true_false wrong zero points'
);
select tests.ok(
  (select is_correct from private.score_response(
    'numeric', '{"type":"numeric","value":3.5,"tolerance":0.1}'::jsonb,
    '{"type":"numeric","text":"3,55"}'::jsonb, 1
  )) = true,
  'numeric tolerance'
);

select tests.ok(true, '90_g6_attempts completed');
rollback;

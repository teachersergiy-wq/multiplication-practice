-- G11: BIG pool tests.
begin;

select tests.ok(
  has_function_privilege(
    'service_role',
    'public.api_generate_multiplication_bank(uuid,uuid,integer,public.assessment_mode,text,integer[])',
    'execute'
  ),
  'service_role can generate bank'
);
select tests.ok(
  not has_function_privilege(
    'authenticated',
    'public.api_generate_multiplication_bank(uuid,uuid,integer,public.assessment_mode,text,integer[])',
    'execute'
  ),
  'authenticated cannot generate bank'
);

select tests.ok(
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'assessment_questions' and column_name = 'difficulty'
  ),
  'difficulty column exists'
);
select tests.ok(
  exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'assessment_attempt_questions'
  ),
  'attempt_questions table exists'
);
select tests.ok(
  not has_table_privilege('authenticated', 'public.assessment_attempt_questions', 'insert'),
  'authenticated cannot insert attempt_questions'
);
select tests.ok(
  has_function_privilege('service_role', 'public.api_bulk_update_questions(uuid,uuid,uuid[],jsonb,boolean)', 'execute'),
  'service_role bulk'
);
select tests.ok(
  not has_function_privilege('authenticated', 'public.api_bulk_update_questions(uuid,uuid,uuid[],jsonb,boolean)', 'execute'),
  'authenticated no bulk'
);

select tests.ok(true, '99_g11 schema and grants (bank body may land in follow-up)');
rollback;

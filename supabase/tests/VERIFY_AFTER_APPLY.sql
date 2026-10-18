-- Read-only verification queries for the owner after applying
-- 20261018010000_tighten_grants_and_policies.sql on a non-production database.
-- Safe to run: SELECT only.

-- 1) Privileges held by anon / authenticated on public tables
select grantee, table_schema, table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'authenticated')
order by grantee, table_name, privilege_type;

-- Expect: anon → zero rows
-- Expect: authenticated → SELECT on listed tables; INSERT/UPDATE/DELETE only on
--   subjects, class_subjects, assessment_templates, assessment_questions,
--   assessment_assignments. No TRUNCATE/TRIGGER/REFERENCES.

-- 2) No client grants on answer keys
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'private'
  and table_name = 'assessment_answer_keys'
  and grantee in ('anon', 'authenticated', 'public');
-- Expect: zero rows

-- 3) multiplication_level_configs policies (manage policy must be gone)
select polname, polcmd, pg_get_expr(polqual, polrelid) as using_expr
from pg_policy
join pg_class c on c.oid = polrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'multiplication_level_configs';
-- Expect: only SELECT policy (multiplication_configs_read), no manage/all policy

-- 4) subjects_read_active definition
select pg_get_expr(polqual, polrelid) as using_expr
from pg_policy
join pg_class c on c.oid = polrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'subjects'
  and polname = 'subjects_read_active';

-- 5) templates_create_owner requires status = draft
select pg_get_expr(polwithcheck, polrelid) as with_check
from pg_policy
join pg_class c on c.oid = polrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'assessment_templates'
  and polname = 'templates_create_owner';

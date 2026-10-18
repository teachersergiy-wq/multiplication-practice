-- Defense in depth: private answer keys remain inaccessible to browser roles.
-- service_role bypasses RLS and already has the only explicit table grant.
alter table private.assessment_answer_keys enable row level security;

-- G2c: remove test-only helper from production schema.
-- Integration tests must seed private.allowed_teachers themselves
-- (service_role insert), not via this function.

drop function if exists public._test_allow_teacher(text);

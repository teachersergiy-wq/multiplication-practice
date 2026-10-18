-- Shared helpers for security tests. Safe to re-run.
-- Simulates RLS context via request.jwt.claim.* and SET ROLE.
-- Failures RAISE EXCEPTION. No pgTAP required.

create schema if not exists tests;

create or replace function tests.fail(msg text)
returns void
language plpgsql
as $$
begin
  raise exception 'TEST FAILED: %', msg;
end;
$$;

create or replace function tests.ok(cond boolean, msg text)
returns void
language plpgsql
as $$
begin
  if not coalesce(cond, false) then
    perform tests.fail(msg);
  end if;
end;
$$;

-- Expects the statement to raise. Any success is a failure.
-- Use for missing GRANTs / WITH CHECK violations that error.
-- Do NOT use for RLS UPDATE/SELECT that succeed with zero rows.
create or replace function tests.throws(sql text, msg text)
returns void
language plpgsql
as $$
begin
  begin
    execute sql;
  exception
    when others then
      -- Expected path: statement failed.
      return;
  end;
  -- Fell through without exception.
  perform tests.fail(msg || ' (expected error, got success)');
end;
$$;

-- Expects DML to affect zero rows (typical silent RLS deny on UPDATE/DELETE).
create or replace function tests.updates_zero_rows(sql text, msg text)
returns void
language plpgsql
as $$
declare
  n integer;
begin
  execute sql;
  get diagnostics n = row_count;
  if n <> 0 then
    perform tests.fail(msg || format(' (expected 0 rows affected, got %s)', n));
  end if;
end;
$$;

create or replace function tests.set_jwt(uid uuid, role_name text default 'authenticated')
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', uid::text, true);
  perform set_config('request.jwt.claim.role', role_name, true);
  perform set_config('role', role_name, true);
end;
$$;

create or replace function tests.clear_jwt()
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('role', 'postgres', true);
end;
$$;

-- Allow test helpers to run while SET ROLE anon/authenticated is active.
grant usage on schema tests to anon, authenticated;
grant execute on all functions in schema tests to anon, authenticated;
alter default privileges in schema tests grant execute on functions to anon, authenticated;

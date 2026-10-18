-- Shared helpers for security tests. Safe to re-run.
-- These tests use SET LOCAL ROLE and request.jwt.claim.* to simulate RLS context.
-- They do not require the pgTAP extension; failures RAISE EXCEPTION.

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

create or replace function tests.throws(sql text, msg text)
returns void
language plpgsql
as $$
begin
  begin
    execute sql;
    perform tests.fail(msg || ' (expected error, got success)');
  exception
    when others then
      null; -- expected
  end;
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

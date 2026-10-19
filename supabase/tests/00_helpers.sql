-- Shared helpers for security tests. Safe to re-run.
-- Matches main/G0: JWT claims for auth.uid(); callers use SET LOCAL ROLE when needed.

create extension if not exists pgcrypto with schema extensions;
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
  exception
    when others then
      return;
  end;
  perform tests.fail(msg || ' (expected error, got success)');
end;
$$;

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

create or replace function tests.ensure_auth_user(p_id uuid, p_email text)
returns void
language plpgsql
as $$
begin
  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, recovery_sent_at, last_sign_in_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token
  ) values (
    p_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    p_email, crypt('test-password', gen_salt('bf')),
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
    now(), now(), '', '', '', ''
  )
  on conflict (id) do nothing;
exception
  when undefined_function then
    insert into auth.users (
      id, instance_id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      confirmation_token, email_change, email_change_token_new, recovery_token
    ) values (
      p_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
      p_email, extensions.crypt('test-password', extensions.gen_salt('bf')),
      now(), now(), now(), '', '', '', ''
    )
    on conflict (id) do nothing;
end;
$$;

grant usage on schema tests to anon, authenticated;
grant execute on all functions in schema tests to anon, authenticated;
alter default privileges in schema tests grant execute on functions to anon, authenticated;

-- G10 (issue #78): teacher administration without SQL for the owner.
-- NOT applied to production by agents. No seed of admin emails/users.

create table if not exists private.admin_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table private.admin_users enable row level security;
revoke all on table private.admin_users from public, anon, authenticated;
grant all on table private.admin_users to service_role;

create table if not exists private.admin_audit (
  id uuid primary key default gen_random_uuid(),
  actor uuid not null references auth.users (id) on delete set null,
  action text not null,
  target uuid,
  created_at timestamptz not null default now()
);

alter table private.admin_audit enable row level security;
revoke all on table private.admin_audit from public, anon, authenticated;
grant all on table private.admin_audit to service_role;

create or replace function private.is_admin(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = private, pg_temp
as $$
  select exists (
    select 1 from private.admin_users a where a.user_id = p_user_id
  );
$$;

revoke all on function private.is_admin(uuid) from public, anon, authenticated;
grant execute on function private.is_admin(uuid) to service_role;

create or replace function public.api_admin_require(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  if p_user_id is null or not private.is_admin(p_user_id) then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.api_admin_require(uuid) from public, anon, authenticated;
grant execute on function public.api_admin_require(uuid) to service_role;

create or replace function public.api_admin_write_audit(
  p_actor uuid,
  p_action text,
  p_target uuid
)
returns void
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  perform public.api_admin_require(p_actor);
  if p_action is null or length(trim(p_action)) < 1 then
    raise exception 'invalid_request: action required' using errcode = 'P0001';
  end if;
  insert into private.admin_audit (actor, action, target)
  values (p_actor, trim(p_action), p_target);
end;
$$;

revoke all on function public.api_admin_write_audit(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.api_admin_write_audit(uuid, text, uuid)
  to service_role;

-- After Auth user exists: allowlist + provision profile/school/class + audit.
create or replace function public.api_admin_register_teacher(
  p_admin_id uuid,
  p_user_id uuid,
  p_email text,
  p_full_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_email text;
  v_name text;
  v_daily integer;
  v_prov jsonb;
  v_created_at timestamptz;
begin
  perform public.api_admin_require(p_admin_id);

  if p_user_id is null then
    raise exception 'invalid_request: userId required' using errcode = 'P0001';
  end if;

  v_email := lower(trim(coalesce(p_email, '')));
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid_request: invalid email' using errcode = 'P0001';
  end if;

  v_name := trim(coalesce(p_full_name, ''));
  if char_length(v_name) < 1 or char_length(v_name) > 120 then
    raise exception 'invalid_request: fullName length 1–120' using errcode = 'P0001';
  end if;

  select count(*)::integer into v_daily
  from private.admin_audit a
  where a.actor = p_admin_id
    and a.action = 'add_teacher'
    and a.created_at >= date_trunc('day', now() at time zone 'utc')
    and a.created_at < date_trunc('day', now() at time zone 'utc') + interval '1 day';

  if v_daily >= 20 then
    raise exception 'conflict: daily add-teacher limit' using errcode = 'P0001';
  end if;

  if exists (select 1 from private.allowed_teachers t where t.email = v_email) then
    raise exception 'conflict: email already allowed' using errcode = 'P0001';
  end if;

  insert into private.allowed_teachers (email, note)
  values (v_email, 'added-by-admin');

  v_prov := public.api_provision_teacher(
    p_user_id,
    v_name,
    'Моя школа',
    'Мій клас'
  );

  insert into private.admin_audit (actor, action, target)
  values (p_admin_id, 'add_teacher', p_user_id);

  select coalesce(p.created_at, now()) into v_created_at
  from public.profiles p where p.id = p_user_id;

  return jsonb_build_object(
    'userId', p_user_id,
    'email', v_email,
    'fullName', v_name,
    'active', true,
    'isAdmin', private.is_admin(p_user_id),
    'createdAt', v_created_at,
    'hasProfile', true,
    'provision', v_prov
  );
end;
$$;

revoke all on function public.api_admin_register_teacher(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.api_admin_register_teacher(uuid, uuid, text, text)
  to service_role;

create or replace function public.api_admin_list_teachers(p_admin_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_result jsonb;
begin
  perform public.api_admin_require(p_admin_id);

  select coalesce(jsonb_agg(row_data order by row_data->>'email'), '[]'::jsonb)
  into v_result
  from (
    select jsonb_build_object(
      'userId', u.id,
      'email', lower(u.email),
      'fullName', p.full_name,
      'active', coalesce(u.banned_until is null or u.banned_until <= now(), true),
      'isAdmin', private.is_admin(u.id),
      'createdAt', coalesce(p.created_at, u.created_at),
      'hasProfile', p.id is not null
    ) as row_data
    from (
      select distinct e.email
      from (
        select email from private.allowed_teachers
        union
        select lower(u2.email)
        from auth.users u2
        join public.profiles pr on pr.id = u2.id and pr.role = 'teacher'
        where u2.email is not null
      ) e
    ) emails
    join auth.users u on lower(u.email) = emails.email
    left join public.profiles p on p.id = u.id
  ) s;

  return jsonb_build_object('teachers', coalesce(v_result, '[]'::jsonb));
end;
$$;

revoke all on function public.api_admin_list_teachers(uuid) from public, anon, authenticated;
grant execute on function public.api_admin_list_teachers(uuid) to service_role;

-- Validates reset/set-active targets: not self; set-active also not admin.
create or replace function public.api_admin_assert_manage_teacher(
  p_admin_id uuid,
  p_target_id uuid,
  p_forbid_admin boolean
)
returns void
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  perform public.api_admin_require(p_admin_id);
  if p_target_id is null then
    raise exception 'invalid_request: userId required' using errcode = 'P0001';
  end if;
  if p_target_id = p_admin_id then
    raise exception 'invalid_request: cannot target self' using errcode = 'P0001';
  end if;
  if p_forbid_admin and private.is_admin(p_target_id) then
    raise exception 'forbidden: cannot manage admin' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.api_admin_assert_manage_teacher(uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.api_admin_assert_manage_teacher(uuid, uuid, boolean)
  to service_role;

create or replace function public.api_admin_teacher_summary(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v jsonb;
begin
  select jsonb_build_object(
    'userId', u.id,
    'email', lower(u.email),
    'fullName', p.full_name,
    'active', coalesce(u.banned_until is null or u.banned_until <= now(), true),
    'isAdmin', private.is_admin(u.id),
    'createdAt', coalesce(p.created_at, u.created_at),
    'hasProfile', p.id is not null
  )
  into v
  from auth.users u
  left join public.profiles p on p.id = u.id
  where u.id = p_user_id;

  if v is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  return v;
end;
$$;

revoke all on function public.api_admin_teacher_summary(uuid) from public, anon, authenticated;
grant execute on function public.api_admin_teacher_summary(uuid) to service_role;

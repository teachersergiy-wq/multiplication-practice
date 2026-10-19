-- G1: public wrappers for service_role only; private not in PostgREST.

create or replace function public.api_is_allowed_teacher(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select exists (
    select 1
    from private.allowed_teachers t
    where t.email = lower(trim(p_email))
  );
$$;

revoke all on function public.api_is_allowed_teacher(text) from public, anon, authenticated;
grant execute on function public.api_is_allowed_teacher(text) to service_role;

create or replace function public.api_provision_teacher(
  p_user_id uuid,
  p_full_name text,
  p_school_name text,
  p_class_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_role public.user_role;
  v_school_id uuid;
  v_class_id uuid;
  v_nick text;
begin
  select p.role into v_role from public.profiles p where p.id = p_user_id;

  if v_role = 'student' then
    raise exception 'forbidden: account is a student' using errcode = '42501';
  end if;

  if v_role = 'teacher' then
    select ct.class_id, c.school_id
      into v_class_id, v_school_id
    from public.class_teachers ct
    join public.classes c on c.id = ct.class_id
    where ct.teacher_id = p_user_id
    order by ct.class_id
    limit 1;

    if v_class_id is null then
      raise exception 'internal: teacher profile missing class link';
    end if;

    return jsonb_build_object(
      'profileId', p_user_id,
      'schoolId', v_school_id,
      'classId', v_class_id,
      'created', false
    );
  end if;

  v_nick := left('Учитель-' || replace(p_user_id::text, '-', ''), 40);

  insert into public.profiles (id, role, full_name, generated_nickname, student_login_code)
  values (p_user_id, 'teacher', p_full_name, v_nick, null)
  on conflict (id) do nothing;

  select p.role into v_role from public.profiles p where p.id = p_user_id;
  if v_role is distinct from 'teacher' then
    raise exception 'forbidden: account is not a teacher' using errcode = '42501';
  end if;

  select ct.class_id, c.school_id
    into v_class_id, v_school_id
  from public.class_teachers ct
  join public.classes c on c.id = ct.class_id
  where ct.teacher_id = p_user_id
  limit 1;

  if v_class_id is not null then
    return jsonb_build_object(
      'profileId', p_user_id,
      'schoolId', v_school_id,
      'classId', v_class_id,
      'created', false
    );
  end if;

  insert into public.schools (name) values (p_school_name) returning id into v_school_id;
  insert into public.classes (school_id, name) values (v_school_id, p_class_name) returning id into v_class_id;
  insert into public.class_teachers (class_id, teacher_id) values (v_class_id, p_user_id)
  on conflict do nothing;

  return jsonb_build_object(
    'profileId', p_user_id,
    'schoolId', v_school_id,
    'classId', v_class_id,
    'created', true
  );
end;
$$;

revoke all on function public.api_provision_teacher(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.api_provision_teacher(uuid, text, text, text) to service_role;

-- Edge integration tests (service_role only)
create or replace function public._test_allow_teacher(p_email text)
returns void
language sql
security definer
set search_path = private, public, pg_temp
as $$
  insert into private.allowed_teachers (email)
  values (lower(trim(p_email)))
  on conflict (email) do nothing;
$$;

revoke all on function public._test_allow_teacher(text) from public, anon, authenticated;
grant execute on function public._test_allow_teacher(text) to service_role;

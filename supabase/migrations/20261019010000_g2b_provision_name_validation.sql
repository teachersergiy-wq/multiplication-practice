-- G2b: enforce fullName length in api_provision_teacher (server-side).
-- LIMITS.fullName min is 1 for students; teacher provision requires >= 2 (API_CONTRACT).

create or replace function public.api_provision_teacher(
  p_user_id uuid,
  p_full_name text,
  p_school_name text default 'Моя школа',
  p_class_name text default 'Мій клас'
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_email text;
  v_profile_id uuid;
  v_school_id uuid;
  v_class_id uuid;
  v_created boolean := false;
  v_nick text;
  v_name text;
  v_school text;
  v_class text;
begin
  v_name := trim(coalesce(p_full_name, ''));
  if char_length(v_name) < 2 or char_length(v_name) > 160 then
    raise exception 'invalid_request: fullName must be 2–160 characters';
  end if;

  v_school := trim(coalesce(p_school_name, 'Моя школа'));
  if char_length(v_school) < 1 or char_length(v_school) > 160 then
    raise exception 'invalid_request: schoolName length';
  end if;

  v_class := trim(coalesce(p_class_name, 'Мій клас'));
  if char_length(v_class) < 1 or char_length(v_class) > 80 then
    raise exception 'invalid_request: className length';
  end if;

  select email into v_email from auth.users where id = p_user_id;
  if v_email is null then
    raise exception 'forbidden: user not found';
  end if;

  if not private.is_allowed_teacher(v_email) then
    raise exception 'forbidden: email not on allowlist';
  end if;

  select id into v_profile_id from public.profiles where id = p_user_id;
  if v_profile_id is not null then
    select ct.class_id into v_class_id
    from public.class_teachers ct
    where ct.teacher_id = p_user_id
    limit 1;

    if v_class_id is not null then
      select c.school_id into v_school_id from public.classes c where c.id = v_class_id;
    end if;

    return jsonb_build_object(
      'profileId', p_user_id,
      'schoolId', v_school_id,
      'classId', v_class_id,
      'created', false
    );
  end if;

  v_nick := left('teacher-' || replace(p_user_id::text, '-', ''), 32);

  insert into public.profiles (id, role, full_name, generated_nickname, student_login_code)
  values (p_user_id, 'teacher', v_name, v_nick, null);

  insert into public.schools (name) values (v_school) returning id into v_school_id;
  insert into public.classes (school_id, name) values (v_school_id, v_class) returning id into v_class_id;
  insert into public.class_teachers (class_id, teacher_id) values (v_class_id, p_user_id)
  on conflict do nothing;

  v_created := true;

  return jsonb_build_object(
    'profileId', p_user_id,
    'schoolId', v_school_id,
    'classId', v_class_id,
    'created', v_created
  );
end;
$$;

revoke all on function public.api_provision_teacher(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.api_provision_teacher(uuid, text, text, text)
  to service_role;

-- G7 (issue #53): create-class and set-class-subject RPC wrappers.
-- NOT applied to production by agents.

-- Teacher creates a class in their school with one subject + grade_level.
create or replace function public.api_create_class(
  p_teacher_id uuid,
  p_name text,
  p_subject_id uuid,
  p_grade_level integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_role public.user_role;
  v_school_id uuid;
  v_class_count integer;
  v_name text;
  v_class_id uuid;
  v_subject_ok boolean;
begin
  select p.role into v_role from public.profiles p where p.id = p_teacher_id;
  if v_role is distinct from 'teacher' then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  v_name := trim(coalesce(p_name, ''));
  if length(v_name) < 1 or length(v_name) > 80 then
    raise exception 'invalid_request: name length 1–80' using errcode = 'P0001';
  end if;

  if p_grade_level is null or p_grade_level < 1 or p_grade_level > 12 then
    raise exception 'invalid_request: gradeLevel must be 1–12' using errcode = 'P0001';
  end if;

  select exists (
    select 1 from public.subjects s
    where s.id = p_subject_id and s.active
      and (s.is_system or s.created_by = p_teacher_id)
  ) into v_subject_ok;
  if not coalesce(v_subject_ok, false) then
    raise exception 'not_found: subject' using errcode = 'P0001';
  end if;

  select c.school_id into v_school_id
  from public.class_teachers ct
  join public.classes c on c.id = ct.class_id
  where ct.teacher_id = p_teacher_id
  order by ct.class_id
  limit 1;

  if v_school_id is null then
    raise exception 'not_found: teacher has no school' using errcode = 'P0001';
  end if;

  select count(*) into v_class_count
  from public.class_teachers ct
  where ct.teacher_id = p_teacher_id;

  if v_class_count >= 20 then
    raise exception 'invalid_request: max 20 classes per teacher' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.classes c
    where c.school_id = v_school_id and c.name = v_name
  ) then
    raise exception 'conflict: class name already exists' using errcode = 'P0001';
  end if;

  insert into public.classes (school_id, name)
  values (v_school_id, v_name)
  returning id into v_class_id;

  insert into public.class_teachers (class_id, teacher_id)
  values (v_class_id, p_teacher_id);

  insert into public.class_subjects (class_id, subject_id, grade_level)
  values (v_class_id, p_subject_id, p_grade_level);

  return jsonb_build_object(
    'classId', v_class_id,
    'schoolId', v_school_id,
    'name', v_name,
    'subjectId', p_subject_id,
    'gradeLevel', p_grade_level
  );
end;
$$;

revoke all on function public.api_create_class(uuid, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.api_create_class(uuid, text, uuid, integer)
  to service_role;

-- Add subject + grade to an existing class the teacher manages.
-- Grade change for an existing subject is forbidden when assignments exist for that subject.
create or replace function public.api_set_class_subject(
  p_teacher_id uuid,
  p_class_id uuid,
  p_subject_id uuid,
  p_grade_level integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_owns boolean;
  v_subject_ok boolean;
  v_existing smallint;
  v_has_assignments boolean;
begin
  select exists (
    select 1 from public.class_teachers ct
    where ct.class_id = p_class_id and ct.teacher_id = p_teacher_id
  ) into v_owns;
  if not coalesce(v_owns, false) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  if p_grade_level is null or p_grade_level < 1 or p_grade_level > 12 then
    raise exception 'invalid_request: gradeLevel must be 1–12' using errcode = 'P0001';
  end if;

  select exists (
    select 1 from public.subjects s
    where s.id = p_subject_id and s.active
      and (s.is_system or s.created_by = p_teacher_id)
  ) into v_subject_ok;
  if not coalesce(v_subject_ok, false) then
    raise exception 'not_found: subject' using errcode = 'P0001';
  end if;

  select cs.grade_level into v_existing
  from public.class_subjects cs
  where cs.class_id = p_class_id and cs.subject_id = p_subject_id;

  if v_existing is not null then
    if v_existing = p_grade_level then
      return jsonb_build_object(
        'classId', p_class_id,
        'subjectId', p_subject_id,
        'gradeLevel', p_grade_level,
        'created', false
      );
    end if;

    select exists (
      select 1
      from public.assessment_assignments a
      join public.assessment_templates t on t.id = a.template_id
      where a.class_id = p_class_id and t.subject_id = p_subject_id
    ) into v_has_assignments;

    if coalesce(v_has_assignments, false) then
      raise exception 'conflict: cannot change gradeLevel while assignments exist for subject'
        using errcode = 'P0001';
    end if;

    update public.class_subjects
      set grade_level = p_grade_level
    where class_id = p_class_id and subject_id = p_subject_id;

    return jsonb_build_object(
      'classId', p_class_id,
      'subjectId', p_subject_id,
      'gradeLevel', p_grade_level,
      'created', false
    );
  end if;

  insert into public.class_subjects (class_id, subject_id, grade_level)
  values (p_class_id, p_subject_id, p_grade_level);

  return jsonb_build_object(
    'classId', p_class_id,
    'subjectId', p_subject_id,
    'gradeLevel', p_grade_level,
    'created', true
  );
end;
$$;

revoke all on function public.api_set_class_subject(uuid, uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.api_set_class_subject(uuid, uuid, uuid, integer)
  to service_role;

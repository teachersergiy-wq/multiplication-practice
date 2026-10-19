-- G4: publish-assessment and clone-assessment (service_role wrappers).
-- NOT applied to production by agents.

-- Stronger publish: validate keys exist and settings shape; return summary.
create or replace function public.api_publish_assessment(
  p_template_id uuid,
  p_teacher_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_owner uuid;
  v_status public.assessment_status;
  v_settings jsonb;
  v_missing uuid[];
  v_qcount integer;
  v_points numeric;
begin
  select teacher_id, status, settings
    into v_owner, v_status, v_settings
  from public.assessment_templates
  where id = p_template_id;

  if v_owner is null or v_owner is distinct from p_teacher_id then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_status is distinct from 'draft' then
    raise exception 'conflict: template not draft' using errcode = 'P0001';
  end if;

  if v_settings is null or jsonb_typeof(v_settings) <> 'object' then
    raise exception 'incomplete_assessment: invalid settings' using errcode = 'P0001';
  end if;

  -- Optional settings bounds (passPercent 1-100, maxErrors >= 0, totalTimeSeconds 1-3600)
  if v_settings ? 'passPercent' then
    if jsonb_typeof(v_settings->'passPercent') <> 'number'
       or (v_settings->>'passPercent')::numeric < 1
       or (v_settings->>'passPercent')::numeric > 100 then
      raise exception 'incomplete_assessment: invalid passPercent' using errcode = 'P0001';
    end if;
  end if;
  if v_settings ? 'maxErrors' then
    if jsonb_typeof(v_settings->'maxErrors') <> 'number'
       or (v_settings->>'maxErrors')::numeric < 0 then
      raise exception 'incomplete_assessment: invalid maxErrors' using errcode = 'P0001';
    end if;
  end if;
  if v_settings ? 'totalTimeSeconds' then
    if jsonb_typeof(v_settings->'totalTimeSeconds') <> 'number'
       or (v_settings->>'totalTimeSeconds')::numeric < 1
       or (v_settings->>'totalTimeSeconds')::numeric > 3600 then
      raise exception 'incomplete_assessment: invalid totalTimeSeconds' using errcode = 'P0001';
    end if;
  end if;

  select count(*), coalesce(sum(points), 0)
    into v_qcount, v_points
  from public.assessment_questions
  where template_id = p_template_id;

  if v_qcount < 1 then
    raise exception 'incomplete_assessment: no questions' using errcode = 'P0001';
  end if;

  select array_agg(q.id)
    into v_missing
  from public.assessment_questions q
  left join private.assessment_answer_keys k on k.question_id = q.id
  where q.template_id = p_template_id
    and (
      k.question_id is null
      or k.answer_key is null
      or (k.answer_key->>'type') is distinct from q.question_type::text
      or q.points is null
      or q.points <= 0
    );

  if v_missing is not null and array_length(v_missing, 1) > 0 then
    raise exception 'incomplete_assessment: bad questions %',
      array_to_string(v_missing, ',')
      using errcode = 'P0001';
  end if;

  update public.assessment_templates
    set status = 'published', updated_at = now()
  where id = p_template_id and status = 'draft';

  if not found then
    raise exception 'conflict: template not draft' using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'templateId', p_template_id,
    'status', 'published',
    'questionCount', v_qcount,
    'totalPoints', v_points
  );
end;
$$;

revoke all on function public.api_publish_assessment(uuid, uuid) from public, anon, authenticated;
grant execute on function public.api_publish_assessment(uuid, uuid) to service_role;

-- Atomic clone: new draft + questions + answer keys; title gets " (копія)".
create or replace function public.api_clone_assessment(
  p_template_id uuid,
  p_teacher_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_src public.assessment_templates%rowtype;
  v_new_id uuid;
  r record;
  v_new_qid uuid;
  v_title text;
begin
  select * into v_src
  from public.assessment_templates
  where id = p_template_id and teacher_id = p_teacher_id;

  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  v_title := left(trim(v_src.title) || ' (копія)', 180);

  insert into public.assessment_templates (
    teacher_id, subject_id, grade_level, title, description, mode, status, settings
  ) values (
    p_teacher_id,
    v_src.subject_id,
    v_src.grade_level,
    v_title,
    v_src.description,
    v_src.mode,
    'draft',
    coalesce(v_src.settings, '{}'::jsonb)
  )
  returning id into v_new_id;

  for r in
    select q.*, k.answer_key, k.checker_version
    from public.assessment_questions q
    left join private.assessment_answer_keys k on k.question_id = q.id
    where q.template_id = p_template_id
    order by q.position
  loop
    insert into public.assessment_questions (
      template_id, position, question_type, prompt, choices, points, time_limit_seconds
    ) values (
      v_new_id, r.position, r.question_type, r.prompt, r.choices, r.points, r.time_limit_seconds
    )
    returning id into v_new_qid;

    if r.answer_key is not null then
      insert into private.assessment_answer_keys (question_id, answer_key, checker_version)
      values (v_new_qid, r.answer_key, coalesce(r.checker_version, 1));
    end if;
  end loop;

  return jsonb_build_object('templateId', v_new_id);
end;
$$;

revoke all on function public.api_clone_assessment(uuid, uuid) from public, anon, authenticated;
grant execute on function public.api_clone_assessment(uuid, uuid) to service_role;

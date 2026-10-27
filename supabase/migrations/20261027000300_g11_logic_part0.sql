-- G11 logic part 0 (issue #84). NOT applied to production by agents.
-- save_question limits 100/1000, shared daily generate counter, G9 uses shared counter.

create or replace function private.save_question_with_key(
  p_template_id uuid,
  p_teacher_id uuid,
  p_question_id uuid,
  p_position integer,
  p_question_type public.question_type,
  p_prompt jsonb,
  p_choices jsonb,
  p_points numeric,
  p_time_limit_seconds integer,
  p_answer_key jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_id uuid;
  v_owner uuid;
  v_status public.assessment_status;
  v_settings jsonb;
  v_version integer;
  v_count integer;
  v_max integer;
begin
  if p_answer_key is null then
    raise exception 'answer_key required';
  end if;

  select teacher_id, status, settings into v_owner, v_status, v_settings
  from public.assessment_templates
  where id = p_template_id
  for update;

  if v_owner is null or v_owner is distinct from p_teacher_id then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_status is distinct from 'draft' then
    raise exception 'conflict: template not draft' using errcode = 'P0001';
  end if;

  v_max := case when v_settings ? 'pool' then 1000 else 100 end;

  if p_question_id is null then
    select count(*)::integer into v_count
    from public.assessment_questions where template_id = p_template_id;
    if v_count >= v_max then
      raise exception 'invalid_request: question limit %', v_max using errcode = 'P0001';
    end if;

    insert into public.assessment_questions (
      template_id, position, question_type, prompt, choices, points, time_limit_seconds
    ) values (
      p_template_id, p_position, p_question_type, p_prompt, coalesce(p_choices, '[]'::jsonb),
      coalesce(p_points, 1), p_time_limit_seconds
    ) returning id into v_id;
  else
    update public.assessment_questions set
      position = p_position,
      question_type = p_question_type,
      prompt = p_prompt,
      choices = coalesce(p_choices, '[]'::jsonb),
      points = coalesce(p_points, 1),
      time_limit_seconds = p_time_limit_seconds
    where id = p_question_id and template_id = p_template_id
    returning id into v_id;
    if v_id is null then
      raise exception 'not_found' using errcode = 'P0001';
    end if;
  end if;

  v_version := case
    when p_question_type in ('multiple_choice', 'ordering', 'matching') then 2
    else 1
  end;

  insert into private.assessment_answer_keys (question_id, answer_key, checker_version)
  values (v_id, p_answer_key, v_version)
  on conflict (question_id) do update
    set answer_key = excluded.answer_key,
        checker_version = excluded.checker_version;

  return v_id;
end;
$$;

revoke all on function private.save_question_with_key(
  uuid, uuid, uuid, integer, public.question_type, jsonb, jsonb, numeric, integer, jsonb
) from public, anon, authenticated;
grant execute on function private.save_question_with_key(
  uuid, uuid, uuid, integer, public.question_type, jsonb, jsonb, numeric, integer, jsonb
) to service_role;

create or replace function private.count_generated_drafts_today(p_teacher_id uuid)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::integer
  from public.assessment_templates t
  where t.teacher_id = p_teacher_id
    and t.created_at >= date_trunc('day', now() at time zone 'utc')
    and t.created_at < date_trunc('day', now() at time zone 'utc') + interval '1 day'
    and coalesce(t.settings->>'source', '') in (
      'generate-multiplication-test',
      'generate-multiplication-bank'
    );
$$;

revoke all on function private.count_generated_drafts_today(uuid) from public, anon, authenticated;
grant execute on function private.count_generated_drafts_today(uuid) to service_role;

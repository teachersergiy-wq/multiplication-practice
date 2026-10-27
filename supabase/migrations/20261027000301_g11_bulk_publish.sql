-- G11: bulk-update-questions returns {affected} per contract; publish pool checks later in 00304.
create or replace function public.api_bulk_update_questions(
  p_teacher_id uuid, p_template_id uuid, p_question_ids uuid[], p_update jsonb, p_delete boolean
) returns jsonb language plpgsql security definer set search_path = public, private, pg_temp as $$
declare
  v_owner uuid; v_status public.assessment_status; v_settings jsonb;
  v_is_pool boolean; v_n int; v_affected int := 0;
  v_diff int; v_pts numeric; v_sec int;
begin
  select teacher_id, status, settings into v_owner, v_status, v_settings
  from public.assessment_templates where id = p_template_id for update;
  if v_owner is null or v_owner is distinct from p_teacher_id then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_status is distinct from 'draft' then
    raise exception 'conflict: template not draft' using errcode = 'P0001';
  end if;
  v_n := coalesce(array_length(p_question_ids, 1), 0);
  if v_n < 1 or v_n > 500 then
    raise exception 'invalid_request: 1–500 question ids' using errcode = 'P0001';
  end if;
  v_is_pool := v_settings ? 'pool';

  if p_delete then
    if p_update is not null then
      raise exception 'invalid_request: update or delete, not both' using errcode = 'P0001';
    end if;
    delete from public.assessment_questions q
    where q.template_id = p_template_id and q.id = any (p_question_ids);
    get diagnostics v_affected = row_count;
    return jsonb_build_object('affected', v_affected);
  end if;

  if p_update is null or jsonb_typeof(p_update) <> 'object' then
    raise exception 'invalid_request: update or delete required' using errcode = 'P0001';
  end if;

  if p_update ? 'difficulty' then
    if not v_is_pool then
      raise exception 'invalid_request: difficulty only on pool templates' using errcode = 'P0001';
    end if;
    v_diff := (p_update->>'difficulty')::integer;
    if v_diff < 1 or v_diff > 5 then
      raise exception 'invalid_request: difficulty 1–5' using errcode = 'P0001';
    end if;
    update public.assessment_questions q set difficulty = v_diff
    where q.template_id = p_template_id and q.id = any (p_question_ids);
    get diagnostics v_affected = row_count;
  end if;

  if p_update ? 'points' then
    v_pts := (p_update->>'points')::numeric;
    if v_pts <= 0 then raise exception 'invalid_request: points > 0' using errcode = 'P0001'; end if;
    update public.assessment_questions q set points = v_pts
    where q.template_id = p_template_id and q.id = any (p_question_ids);
    get diagnostics v_affected = row_count;
  end if;

  if p_update ? 'timeLimitSeconds' then
    if p_update->'timeLimitSeconds' is null or jsonb_typeof(p_update->'timeLimitSeconds') = 'null' then
      update public.assessment_questions q set time_limit_seconds = null
      where q.template_id = p_template_id and q.id = any (p_question_ids);
    else
      v_sec := (p_update->>'timeLimitSeconds')::integer;
      if v_sec < 1 or v_sec > 3600 then
        raise exception 'invalid_request: timeLimitSeconds 1–3600' using errcode = 'P0001';
      end if;
      update public.assessment_questions q set time_limit_seconds = v_sec
      where q.template_id = p_template_id and q.id = any (p_question_ids);
    end if;
    get diagnostics v_affected = row_count;
  end if;

  return jsonb_build_object('affected', v_affected);
end; $$;
revoke all on function public.api_bulk_update_questions(uuid,uuid,uuid[],jsonb,boolean) from public, anon, authenticated;
grant execute on function public.api_bulk_update_questions(uuid,uuid,uuid[],jsonb,boolean) to service_role;

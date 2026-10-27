-- G11: submit must be in sample; finalize scores sample only; publish pool validation

create or replace function public.api_publish_assessment(p_template_id uuid, p_teacher_id uuid)
returns jsonb language plpgsql security definer set search_path = public, private, pg_temp as $$
declare
  v_owner uuid; v_status public.assessment_status; v_settings jsonb;
  v_qcount int; v_points numeric; v_bad text[] := '{}'; v_num numeric;
  v_is_pool boolean; v_lc int[]; v_sum int := 0; v_i int; v_have int; r record;
begin
  select teacher_id, status, settings into v_owner, v_status, v_settings
  from public.assessment_templates where id = p_template_id for update;
  if v_owner is null or v_owner is distinct from p_teacher_id then raise exception 'not_found' using errcode='P0001'; end if;
  if v_status is distinct from 'draft' then raise exception 'conflict: template not draft' using errcode='P0001'; end if;
  if v_settings ? 'passPercent' then
    if jsonb_typeof(v_settings->'passPercent') <> 'number' or (v_settings->>'passPercent')::numeric < 1 or (v_settings->>'passPercent')::numeric > 100 then
      raise exception 'incomplete_assessment: invalid passPercent' using errcode='P0001'; end if;
  end if;
  select count(*), coalesce(sum(points),0) into v_qcount, v_points from public.assessment_questions where template_id = p_template_id;
  if v_qcount < 1 then raise exception 'incomplete_assessment: no questions' using errcode='P0001'; end if;
  for r in select q.id, q.points, k.answer_key from public.assessment_questions q
    left join private.assessment_answer_keys k on k.question_id = q.id where q.template_id = p_template_id
  loop
    if r.answer_key is null or r.points is null or r.points <= 0 then v_bad := array_append(v_bad, r.id::text); end if;
  end loop;
  v_is_pool := v_settings ? 'pool';
  if v_is_pool then
    if jsonb_typeof(v_settings->'pool'->'levelCounts') <> 'array' or jsonb_array_length(v_settings->'pool'->'levelCounts') <> 5 then
      raise exception 'incomplete_assessment: pool.levelCounts' using errcode='P0001'; end if;
    v_lc := array[
      (v_settings->'pool'->'levelCounts'->>0)::int,(v_settings->'pool'->'levelCounts'->>1)::int,
      (v_settings->'pool'->'levelCounts'->>2)::int,(v_settings->'pool'->'levelCounts'->>3)::int,
      (v_settings->'pool'->'levelCounts'->>4)::int];
    for v_i in 1..5 loop
      if v_lc[v_i] is null or v_lc[v_i] < 0 then raise exception 'incomplete_assessment: pool.levelCounts' using errcode='P0001'; end if;
      v_sum := v_sum + v_lc[v_i];
    end loop;
    if v_sum < 1 or v_sum > 100 then raise exception 'incomplete_assessment: pool sum' using errcode='P0001'; end if;
    if exists (select 1 from public.assessment_questions q where q.template_id = p_template_id and q.difficulty is null) then
      raise exception 'incomplete_assessment: pool questions need difficulty' using errcode='P0001'; end if;
    for v_i in 1..5 loop
      select count(*)::int into v_have from public.assessment_questions q where q.template_id = p_template_id and q.difficulty = v_i;
      if v_have < v_lc[v_i] then
        raise exception 'incomplete_assessment: not enough difficulty % (have %, need %)', v_i, v_have, v_lc[v_i] using errcode='P0001';
      end if;
    end loop;
  end if;
  if coalesce(array_length(v_bad,1),0) > 0 then
    raise exception 'incomplete_assessment: bad questions %', array_to_string(v_bad,',') using errcode='P0001';
  end if;
  update public.assessment_templates set status = 'published', updated_at = now() where id = p_template_id;
  return jsonb_build_object('templateId', p_template_id, 'status', 'published', 'questionCount', v_qcount, 'totalPoints', v_points);
end; $$;
revoke all on function public.api_publish_assessment(uuid,uuid) from public, anon, authenticated;
grant execute on function public.api_publish_assessment(uuid,uuid) to service_role;

create or replace function public.api_clone_assessment(p_template_id uuid, p_teacher_id uuid)
returns jsonb language plpgsql security definer set search_path = public, private, pg_temp as $$
declare
  v_src public.assessment_templates%rowtype; v_new_id uuid; v_new_qid uuid; r record;
begin
  select * into v_src from public.assessment_templates where id = p_template_id;
  if not found or v_src.teacher_id is distinct from p_teacher_id then raise exception 'not_found' using errcode='P0001'; end if;
  insert into public.assessment_templates (teacher_id, subject_id, grade_level, title, description, mode, status, settings)
  values (p_teacher_id, v_src.subject_id, v_src.grade_level, left(v_src.title || ' (копія)', 180), v_src.description, v_src.mode, 'draft', v_src.settings)
  returning id into v_new_id;
  for r in
    select q.*, k.answer_key, k.checker_version from public.assessment_questions q
    left join private.assessment_answer_keys k on k.question_id = q.id
    where q.template_id = p_template_id order by q.position
  loop
    insert into public.assessment_questions (template_id, position, question_type, prompt, choices, points, time_limit_seconds, difficulty)
    values (v_new_id, r.position, r.question_type, r.prompt, r.choices, r.points, r.time_limit_seconds, r.difficulty)
    returning id into v_new_qid;
    if r.answer_key is not null then
      insert into private.assessment_answer_keys (question_id, answer_key, checker_version)
      values (v_new_qid, r.answer_key, coalesce(r.checker_version, 1));
    end if;
  end loop;
  return jsonb_build_object('templateId', v_new_id);
end; $$;
revoke all on function public.api_clone_assessment(uuid,uuid) from public, anon, authenticated;
grant execute on function public.api_clone_assessment(uuid,uuid) to service_role;

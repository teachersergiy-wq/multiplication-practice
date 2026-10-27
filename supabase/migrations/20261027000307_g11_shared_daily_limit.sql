-- G11: generate-multiplication-test uses shared daily counter with bank
create or replace function public.api_generate_multiplication_test(
  p_teacher_id uuid,
  p_subject_id uuid,
  p_grade_level integer,
  p_level_number integer,
  p_mode public.assessment_mode,
  p_title text
) returns jsonb language plpgsql security definer set search_path = public, private, pg_temp as $$
declare
  v_role public.user_role; v_subj_code text; v_subj_active boolean;
  v_cfg public.multiplication_level_configs%rowtype;
  v_title text; v_settings jsonb; v_template_id uuid; v_daily int;
  v_pair record; v_pos int := 0; v_qid uuid; v_need int; v_have int; v_a int; v_b int;
begin
  if p_teacher_id is null or p_subject_id is null then raise exception 'invalid_request: teacherId and subjectId required' using errcode='P0001'; end if;
  if p_grade_level is null or p_grade_level < 1 or p_grade_level > 11 then raise exception 'invalid_request: gradeLevel must be 1–11' using errcode='P0001'; end if;
  if p_level_number is null or p_level_number < 1 or p_level_number > 5 then raise exception 'invalid_request: levelNumber must be 1–5' using errcode='P0001'; end if;
  if p_mode is null then raise exception 'invalid_request: mode required' using errcode='P0001'; end if;
  select role into v_role from public.profiles where id = p_teacher_id;
  if v_role is distinct from 'teacher' then raise exception 'not_found' using errcode='P0001'; end if;
  select code, active into v_subj_code, v_subj_active from public.subjects where id = p_subject_id;
  if v_subj_code is null or not coalesce(v_subj_active,false) or v_subj_code is distinct from 'mathematics' then raise exception 'not_found' using errcode='P0001'; end if;
  select c.* into v_cfg from public.multiplication_level_configs c
  where c.subject_id = p_subject_id and c.level_number = p_level_number and c.active and c.grade_level <= p_grade_level
  order by c.grade_level desc limit 1;
  if not found then raise exception 'not_found' using errcode='P0001'; end if;
  v_daily := private.count_generated_drafts_today(p_teacher_id);
  if v_daily >= 30 then raise exception 'conflict: daily generate limit' using errcode='P0001'; end if;
  v_title := nullif(trim(coalesce(p_title,'')),'');
  if v_title is null then v_title := format('Множення: рівень %s', p_level_number); end if;
  if length(v_title) > 120 then raise exception 'invalid_request: title length 1–120' using errcode='P0001'; end if;
  v_settings := jsonb_build_object('passPercent', v_cfg.pass_percent, 'maxErrors', v_cfg.max_errors,
    'source', 'generate-multiplication-test', 'levelNumber', p_level_number, 'configGradeLevel', v_cfg.grade_level);
  insert into public.assessment_templates (teacher_id, subject_id, grade_level, title, mode, status, settings)
  values (p_teacher_id, p_subject_id, p_grade_level, v_title, p_mode, 'draft', v_settings) returning id into v_template_id;
  create temporary table if not exists _g9_pairs (a smallint, b smallint, ord float) on commit drop;
  delete from _g9_pairs;
  insert into _g9_pairs (a, b, ord)
  select x.a, x.b, random() from (
    select least(i,j) as a, greatest(i,j) as b
    from generate_series(v_cfg.min_factor::int, v_cfg.max_factor::int) i
    cross join generate_series(v_cfg.min_factor::int, v_cfg.max_factor::int) j group by 1,2
  ) x;
  select count(*)::int into v_have from _g9_pairs;
  v_need := v_cfg.question_count;
  if v_have < v_need then
    insert into _g9_pairs (a,b,ord) select s.a,s.b,random() from (values (11,11),(12,12)) s(a,b)
    where not exists (select 1 from _g9_pairs p where p.a=s.a and p.b=s.b);
  end if;
  for v_pair in select p.a, p.b from _g9_pairs p order by p.ord limit v_need loop
    v_pos := v_pos + 1;
    if random() < 0.5 then v_a := v_pair.a; v_b := v_pair.b; else v_a := v_pair.b; v_b := v_pair.a; end if;
    v_qid := private.save_question_with_key(
      v_template_id, p_teacher_id, null, v_pos, 'numeric'::public.question_type,
      jsonb_build_object('text', format('%s × %s = ?', v_a, v_b)), '[]'::jsonb, 1, v_cfg.seconds_per_question,
      jsonb_build_object('type','numeric','value', v_a*v_b, 'tolerance', 0)
    );
  end loop;
  return jsonb_build_object('templateId', v_template_id, 'title', v_title, 'questionCount', v_pos,
    'configGradeLevel', v_cfg.grade_level,
    'settings', jsonb_build_object('passPercent', v_cfg.pass_percent, 'maxErrors', v_cfg.max_errors));
end; $$;
revoke all on function public.api_generate_multiplication_test(uuid,uuid,integer,integer,public.assessment_mode,text) from public, anon, authenticated;
grant execute on function public.api_generate_multiplication_test(uuid,uuid,integer,integer,public.assessment_mode,text) to service_role;

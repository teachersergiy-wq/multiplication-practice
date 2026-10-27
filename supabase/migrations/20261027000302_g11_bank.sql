-- G11: generate-multiplication-bank — no temp table / no DELETE (pg_safeupdate).
-- Grade level 1–11 (D8). Level-5 compounds via CTE ordered by random().
create or replace function public.api_generate_multiplication_bank(
  p_teacher_id uuid, p_subject_id uuid, p_grade_level integer,
  p_mode public.assessment_mode, p_title text, p_level_counts integer[]
) returns jsonb language plpgsql security definer set search_path = public, private, pg_temp as $$
declare
  v_role public.user_role; v_code text; v_active boolean; v_title text; v_settings jsonb;
  v_template_id uuid; v_daily int; v_pos int := 0; v_qid uuid; v_a int; v_b int; v_c int; v_k int; v_val int;
  v_diff int; v_pts numeric; v_sec int; v_counts int[] := array[0,0,0,0,0]; v_lc int[]; v_sum int := 0; v_i int; r record;
begin
  if p_teacher_id is null or p_subject_id is null then raise exception 'invalid_request: teacherId and subjectId required' using errcode='P0001'; end if;
  if p_grade_level is null or p_grade_level not between 1 and 11 then raise exception 'invalid_request: gradeLevel must be 1–11' using errcode='P0001'; end if;
  if p_mode is null then raise exception 'invalid_request: mode required' using errcode='P0001'; end if;
  select role into v_role from public.profiles where id=p_teacher_id;
  if v_role is distinct from 'teacher' then raise exception 'not_found' using errcode='P0001'; end if;
  select code, active into v_code, v_active from public.subjects where id=p_subject_id;
  if v_code is null or not coalesce(v_active,false) or v_code is distinct from 'mathematics' then raise exception 'not_found' using errcode='P0001'; end if;
  v_lc := coalesce(p_level_counts, array[5,10,10,5,0]);
  if array_length(v_lc,1) is distinct from 5 then raise exception 'invalid_request: levelCounts must have 5 elements' using errcode='P0001'; end if;
  for v_i in 1..5 loop
    if v_lc[v_i] is null or v_lc[v_i]<0 then raise exception 'invalid_request: levelCounts >= 0' using errcode='P0001'; end if;
    v_sum := v_sum + v_lc[v_i];
  end loop;
  if v_sum not between 1 and 100 then raise exception 'invalid_request: sum(levelCounts) must be 1–100' using errcode='P0001'; end if;
  v_daily := private.count_generated_drafts_today(p_teacher_id);
  if v_daily >= 30 then raise exception 'conflict: daily generate limit' using errcode='P0001'; end if;
  v_title := coalesce(nullif(trim(coalesce(p_title,'')),''), 'BIG таблиця множення');
  if length(v_title)>120 then raise exception 'invalid_request: title length 1–120' using errcode='P0001'; end if;
  v_settings := jsonb_build_object('pool',jsonb_build_object('levelCounts',jsonb_build_array(v_lc[1],v_lc[2],v_lc[3],v_lc[4],v_lc[5])),'source','generate-multiplication-bank');
  insert into public.assessment_templates(teacher_id,subject_id,grade_level,title,mode,status,settings)
  values(p_teacher_id,p_subject_id,p_grade_level,v_title,p_mode,'draft',v_settings) returning id into v_template_id;

  -- Multiplication a×b, a,b ∈ 0..10
  for v_a in 0..10 loop for v_b in 0..10 loop
    v_diff := case when v_a in (0,1,2,10) or v_b in (0,1,2,10) then 1 when v_a in (3,5) or v_b in (3,5) or v_a=v_b then 2 else 3 end;
    v_pts := case v_diff when 1 then 1 when 2 then 1 when 3 then 2 when 4 then 3 else 4 end;
    v_sec := case v_diff when 1 then 8 when 2 then 8 when 3 then 10 when 4 then 12 else 20 end;
    v_pos:=v_pos+1;
    insert into public.assessment_questions(template_id,position,question_type,prompt,choices,points,time_limit_seconds,difficulty)
    values(v_template_id,v_pos,'numeric',jsonb_build_object('text',format('%s × %s = ?',v_a,v_b)),'[]'::jsonb,v_pts,v_sec,v_diff) returning id into v_qid;
    insert into private.assessment_answer_keys(question_id,answer_key,checker_version) values(v_qid,jsonb_build_object('type','numeric','value',v_a*v_b,'tolerance',0),1);
    v_counts[v_diff]:=v_counts[v_diff]+1;
  end loop; end loop;

  -- Division a÷b = k
  for v_b in 1..10 loop for v_k in 0..10 loop
    v_a:=v_b*v_k;
    v_diff:=case when v_a=0 or v_a=v_b or v_b=1 or v_b=10 then 1 when v_b=2 then 2 when v_b in (3,4,5) then 3 else 4 end;
    v_pts:=case v_diff when 1 then 1 when 2 then 1 when 3 then 2 when 4 then 3 else 4 end;
    v_sec:=case v_diff when 1 then 8 when 2 then 8 when 3 then 10 when 4 then 12 else 20 end;
    v_pos:=v_pos+1;
    insert into public.assessment_questions(template_id,position,question_type,prompt,choices,points,time_limit_seconds,difficulty)
    values(v_template_id,v_pos,'numeric',jsonb_build_object('text',format('%s ÷ %s = ?',v_a,v_b)),'[]'::jsonb,v_pts,v_sec,v_diff) returning id into v_qid;
    insert into private.assessment_answer_keys(question_id,answer_key,checker_version) values(v_qid,jsonb_build_object('type','numeric','value',v_k,'tolerance',0),1);
    v_counts[v_diff]:=v_counts[v_diff]+1;
  end loop; end loop;

  -- Level 5: compounds via CTE (no temp table / DELETE) + squares 11²..15²
  for r in
    with cand as (
      select format('%s × %s ÷ %s = ?', a, b, c) as prompt,
             (a * b) / c as value,
             random() as ord
      from generate_series(2,10) a
      cross join generate_series(2,10) b
      cross join generate_series(2,10) c
      where (a * b) % c = 0
        and ((a * b) / c) between 2 and 10
        and c is distinct from a and c is distinct from b
      union all
      select format('%s ÷ %s × %s = ?', a, b, c),
             (a / b) * c,
             random()
      from generate_series(2,10) a
      cross join generate_series(2,10) b
      cross join generate_series(2,10) c
      where a % b = 0
        and (a / b) between 2 and 10
        and c is distinct from a and c is distinct from b
    )
    select prompt, value from cand order by ord limit 200
  loop
    v_pos:=v_pos+1;
    insert into public.assessment_questions(template_id,position,question_type,prompt,choices,points,time_limit_seconds,difficulty)
    values(v_template_id,v_pos,'numeric',jsonb_build_object('text',r.prompt),'[]'::jsonb,4,20,5) returning id into v_qid;
    insert into private.assessment_answer_keys(question_id,answer_key,checker_version) values(v_qid,jsonb_build_object('type','numeric','value',r.value,'tolerance',0),1);
    v_counts[5]:=v_counts[5]+1;
  end loop;

  for v_a in 11..15 loop
    v_pos:=v_pos+1;
    insert into public.assessment_questions(template_id,position,question_type,prompt,choices,points,time_limit_seconds,difficulty)
    values(v_template_id,v_pos,'numeric',jsonb_build_object('text',format('%s × %s = ?',v_a,v_a)),'[]'::jsonb,4,20,5) returning id into v_qid;
    insert into private.assessment_answer_keys(question_id,answer_key,checker_version) values(v_qid,jsonb_build_object('type','numeric','value',v_a*v_a,'tolerance',0),1);
    v_counts[5]:=v_counts[5]+1;
  end loop;

  return jsonb_build_object('templateId',v_template_id,'title',v_title,'bankSize',v_pos,
    'bankByLevel',jsonb_build_array(v_counts[1],v_counts[2],v_counts[3],v_counts[4],v_counts[5]),
    'settings',jsonb_build_object('pool',jsonb_build_object('levelCounts',jsonb_build_array(v_lc[1],v_lc[2],v_lc[3],v_lc[4],v_lc[5]))));
end; $$;
revoke all on function public.api_generate_multiplication_bank(uuid,uuid,integer,public.assessment_mode,text,integer[]) from public,anon,authenticated;
grant execute on function public.api_generate_multiplication_bank(uuid,uuid,integer,public.assessment_mode,text,integer[]) to service_role;

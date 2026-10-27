-- G11: BIG pool bank, sample, bulk, publish checks.
begin;

select tests.ok(
  has_function_privilege(
    'service_role',
    'public.api_generate_multiplication_bank(uuid,uuid,integer,public.assessment_mode,text,integer[])',
    'execute'
  ),
  'service_role can generate bank'
);
select tests.ok(
  not has_function_privilege(
    'authenticated',
    'public.api_generate_multiplication_bank(uuid,uuid,integer,public.assessment_mode,text,integer[])',
    'execute'
  ),
  'authenticated cannot generate bank'
);
select tests.ok(
  not has_table_privilege('authenticated', 'public.assessment_attempt_questions', 'insert'),
  'authenticated cannot insert attempt_questions'
);

do $$
declare
  v_tid uuid := 'c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c101';
  v_sid uuid := 'c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c102';
  v_other uuid := 'c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c103';
  v_subj uuid; v_school uuid; v_class uuid;
  res jsonb; v_tpl uuid; v_bank int; v_l1 int; v_l5 int;
  v_asg uuid; v_att1 uuid; v_att2 uuid; n1 int; n2 int; v_q_out uuid;
begin
  perform tests.ensure_auth_user(v_tid, 'g11-teacher@test.local');
  perform tests.ensure_auth_user(v_sid, 'g11-student@test.local');
  perform tests.ensure_auth_user(v_other, 'g11-other@test.local');

  insert into public.profiles (id, role, full_name, generated_nickname, student_login_code)
  values
    (v_tid, 'teacher', 'G11 Teacher', 'G11TEACH', null),
    (v_other, 'teacher', 'G11 Other', 'G11OTHER', null),
    (v_sid, 'student', 'G11 Student', 'G11STUD', 'g11s')
  on conflict (id) do nothing;

  select id into v_subj from public.subjects where code = 'mathematics' limit 1;
  insert into public.schools (name) values ('G11 School') returning id into v_school;
  insert into public.classes (school_id, name) values (v_school, 'G11 Class') returning id into v_class;
  insert into public.class_teachers (class_id, teacher_id) values (v_class, v_tid);
  insert into public.class_students (class_id, student_id) values (v_class, v_sid);

  res := public.api_generate_multiplication_bank(
    v_tid, v_subj, 5, 'practice'::public.assessment_mode, 'G11 BIG', array[2,2,2,1,0]
  );
  v_tpl := (res->>'templateId')::uuid;
  v_bank := (res->>'bankSize')::int;
  v_l1 := (res->'bankByLevel'->>0)::int;
  v_l5 := (res->'bankByLevel'->>4)::int;
  perform tests.ok(v_bank > 200, format('bankSize=%s', v_bank));
  perform tests.ok(v_l1 > 0, 'level1 populated');
  perform tests.ok(v_l5 > 0, 'level5 populated');

  select id into v_q_out from public.assessment_questions where template_id = v_tpl limit 1;
  res := public.api_bulk_update_questions(
    v_tid, v_tpl, array[v_q_out], jsonb_build_object('difficulty', 4), false
  );
  perform tests.ok((res->>'affected')::int = 1, 'bulk affected');

  begin
    perform public.api_bulk_update_questions(
      v_other, v_tpl, array[v_q_out], jsonb_build_object('points', 2), false
    );
    perform tests.fail('other teacher bulk');
  exception when others then
    perform tests.ok(sqlerrm ilike '%not_found%', 'other teacher not_found');
  end;

  res := public.api_publish_assessment(v_tpl, v_tid);
  perform tests.ok(res->>'status' = 'published', 'published pool');

  insert into public.assessment_templates (
    teacher_id, subject_id, grade_level, title, mode, status, settings
  ) values (
    v_tid, v_subj, 5, 'tiny pool', 'practice', 'draft',
    jsonb_build_object('pool', jsonb_build_object('levelCounts', jsonb_build_array(5,0,0,0,0)))
  ) returning id into v_tpl;
  insert into public.assessment_questions (
    template_id, position, question_type, prompt, points, time_limit_seconds, difficulty
  ) values (v_tpl, 1, 'numeric', '{"text":"1 × 1 = ?"}'::jsonb, 1, 8, 1) returning id into v_q_out;
  insert into private.assessment_answer_keys (question_id, answer_key)
  values (v_q_out, '{"type":"numeric","value":1,"tolerance":0}'::jsonb);
  begin
    perform public.api_publish_assessment(v_tpl, v_tid);
    perform tests.fail('should incomplete');
  exception when others then
    perform tests.ok(sqlerrm ilike '%incomplete_assessment%', 'incomplete pool');
  end;

  select id into v_tpl from public.assessment_templates
  where teacher_id = v_tid and title = 'G11 BIG' and status = 'published' limit 1;
  insert into public.assessment_assignments (template_id, class_id, assigned_by, allow_retries)
  values (v_tpl, v_class, v_tid, true) returning id into v_asg;

  res := public.api_start_attempt(v_asg, v_sid);
  v_att1 := (res->>'attemptId')::uuid;
  n1 := jsonb_array_length(res->'questions');
  perform tests.ok(n1 = 7, format('sample size=%s', n1));

  res := public.api_start_attempt(v_asg, v_sid);
  perform tests.ok((res->>'resumed')::boolean = true, 'resumed');
  perform tests.ok((res->>'attemptId')::uuid = v_att1, 'same attempt');

  perform private.finalize_attempt(v_att1);
  res := public.api_start_attempt(v_asg, v_sid);
  v_att2 := (res->>'attemptId')::uuid;
  perform tests.ok(v_att2 is distinct from v_att1, 'new attempt');
  n2 := jsonb_array_length(res->'questions');
  perform tests.ok(n2 = 7, 'second sample size');

  select q.id into v_q_out from public.assessment_questions q
  where q.template_id = v_tpl
    and not exists (
      select 1 from public.assessment_attempt_questions aq
      where aq.attempt_id = v_att2 and aq.question_id = q.id
    ) limit 1;
  begin
    perform public.api_submit_answer(v_att2, v_sid, v_q_out, jsonb_build_object('type','numeric','value',0));
    perform tests.fail('out of sample');
  exception when others then
    perform tests.ok(sqlerrm ilike '%not_found%', 'out of sample not_found');
  end;

  perform tests.set_jwt(v_sid, 'authenticated');
  begin
    insert into public.assessment_attempt_questions (attempt_id, question_id, position)
    values (v_att2, v_q_out, 99);
    perform tests.fail('student write');
  exception when others then
    perform tests.ok(true, 'student cannot write attempt_questions');
  end;
  perform tests.clear_jwt();
end;
$$;

select tests.ok(true, '99_g11_big_pool completed');
rollback;

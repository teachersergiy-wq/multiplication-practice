-- G11b: api_start_attempt returns student-facing shape (promptText, no answer data) for pool and regular tests.
begin;
do $$
declare
  v_tid uuid := 'c2c2c2c2-c2c2-c2c2-c2c2-c2c2c2c2c201';
  v_sid uuid := 'c2c2c2c2-c2c2-c2c2-c2c2-c2c2c2c2c202';
  v_subj uuid; v_school uuid; v_class uuid; v_tpl uuid; v_asg uuid; res jsonb; q jsonb; v_qid uuid;
begin
  perform tests.ensure_auth_user(v_tid, 'g11b-teacher@test.local');
  perform tests.ensure_auth_user(v_sid, 'g11b-student@test.local');
  insert into public.profiles (id, role, full_name, generated_nickname, student_login_code)
  values (v_tid, 'teacher', 'G11b Teacher', 'G11BT', null), (v_sid, 'student', 'G11b Student', 'G11BS', 'g11b')
  on conflict (id) do nothing;
  select id into v_subj from public.subjects where code = 'mathematics' limit 1;
  insert into public.schools (name) values ('G11b School') returning id into v_school;
  insert into public.classes (school_id, name) values (v_school, 'G11b Class') returning id into v_class;
  insert into public.class_teachers (class_id, teacher_id) values (v_class, v_tid);
  insert into public.class_students (class_id, student_id) values (v_class, v_sid);

  -- regular published numeric test
  insert into public.assessment_templates (teacher_id, subject_id, grade_level, title, mode, status, settings)
  values (v_tid, v_subj, 5, 'G11b regular', 'practice', 'draft', '{}'::jsonb) returning id into v_tpl;
  insert into public.assessment_questions (template_id, position, question_type, prompt, points, time_limit_seconds)
  values (v_tpl, 1, 'numeric', '{"text":"6 × 7 = ?"}'::jsonb, 1, 8) returning id into v_qid;
  insert into private.assessment_answer_keys (question_id, answer_key)
  values (v_qid, '{"type":"numeric","value":42,"tolerance":0}'::jsonb);
  perform public.api_publish_assessment(v_tpl, v_tid);
  insert into public.assessment_assignments (template_id, class_id, assigned_by)
  values (v_tpl, v_class, v_tid) returning id into v_asg;

  res := public.api_start_attempt(v_asg, v_sid);
  q := res->'questions'->0;
  perform tests.ok(q->>'promptText' = '6 × 7 = ?', 'promptText returned');
  perform tests.ok(not (q ? 'prompt'), 'raw prompt not exposed');
  perform tests.ok(not (q ? 'choices'), 'no choices for numeric');
  perform tests.ok(not (q::text ilike '%answer%'), 'no answer data');
end;
$$;
select tests.ok(true, '99b_g11b_start_shape completed');
rollback;

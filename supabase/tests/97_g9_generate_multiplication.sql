-- G9: generate-multiplication-test configs + RPC behaviour.
begin;

select tests.ok(
  has_function_privilege(
    'service_role',
    'public.api_generate_multiplication_test(uuid,uuid,integer,integer,public.assessment_mode,text)',
    'execute'
  ),
  'service_role can generate'
);
select tests.ok(
  not has_function_privilege(
    'authenticated',
    'public.api_generate_multiplication_test(uuid,uuid,integer,integer,public.assessment_mode,text)',
    'execute'
  ),
  'authenticated cannot generate RPC'
);

do $$
declare
  tid uuid := 'a9a9a9a9-a9a9-a9a9-a9a9-a9a9a9a9a901';
  other uuid := 'a9a9a9a9-a9a9-a9a9-a9a9-a9a9a9a9a902';
  sid uuid := 'a9a9a9a9-a9a9-a9a9-a9a9-a9a9a9a9a903';
  subj uuid;
  res jsonb;
  tpl uuid;
  cnt int;
  n_pairs int;
  v_min int;
  v_max int;
  bad int;
  has_sq11 boolean;
  has_sq12 boolean;
begin
  perform tests.ensure_auth_user(tid, 'g9-teacher@test.local');
  perform tests.ensure_auth_user(other, 'g9-other@test.local');
  perform tests.ensure_auth_user(sid, 'g9-student@test.local');

  insert into public.profiles (id, role, full_name, generated_nickname, student_login_code)
  values
    (tid, 'teacher', 'G9 Teacher', 'G9TEACH', null),
    (other, 'teacher', 'G9 Other', 'G9OTHER', null),
    (sid, 'student', 'G9 Student', 'G9STUD', 'g9st')
  on conflict (id) do nothing;

  select id into subj from public.subjects where code = 'mathematics' limit 1;

  perform tests.ok(
    (select count(*) from public.multiplication_level_configs c
     where c.subject_id = subj and c.grade_level = 3 and c.level_number = 5
       and c.question_count = 30 and c.min_factor = 3 and c.max_factor = 9) = 1,
    'grade 3 level 5 updated'
  );
  perform tests.ok(
    (select count(*) from public.multiplication_level_configs c
     where c.subject_id = subj and c.grade_level in (5,6,7,8,9)) = 25,
    'grades 5–9 have 5 levels each'
  );

  res := public.api_generate_multiplication_test(
    tid, subj, 3, 1, 'practice'::public.assessment_mode, null
  );
  tpl := (res->>'templateId')::uuid;
  perform tests.ok((res->>'questionCount')::int = 10, 'level1 questionCount=10');
  perform tests.ok((res->>'configGradeLevel')::int = 3, 'configGradeLevel=3');
  perform tests.ok((res->'settings'->>'passPercent')::int = 70, 'passPercent 70');
  perform tests.ok((res->'settings'->>'maxErrors')::int = 3, 'maxErrors 3');

  perform tests.ok(
    exists (
      select 1 from public.assessment_templates t
      where t.id = tpl and t.status = 'draft' and t.teacher_id = tid
        and t.grade_level = 3 and t.mode = 'practice'
    ),
    'template is draft owned by teacher'
  );

  select count(*) into cnt from public.assessment_questions where template_id = tpl;
  perform tests.ok(cnt = 10, '10 questions inserted');

  select min_factor, max_factor into v_min, v_max
  from public.multiplication_level_configs
  where subject_id = subj and grade_level = 3 and level_number = 1;

  select count(*) into bad
  from public.assessment_questions q
  join private.assessment_answer_keys k on k.question_id = q.id
  where q.template_id = tpl
    and (
      q.question_type is distinct from 'numeric'
      or (k.answer_key->>'tolerance')::numeric is distinct from 0
      or q.points is distinct from 1
      or q.time_limit_seconds is distinct from 15
    );
  perform tests.ok(bad = 0, 'numeric shape and limits');

  select count(*) into n_pairs
  from (
    select distinct least(a, b), greatest(a, b)
    from (
      select
        (regexp_match(q.prompt->>'text', '(\d+)\s*×\s*(\d+)'))[1]::int as a,
        (regexp_match(q.prompt->>'text', '(\d+)\s*×\s*(\d+)'))[2]::int as b,
        (k.answer_key->>'value')::int as prod
      from public.assessment_questions q
      join private.assessment_answer_keys k on k.question_id = q.id
      where q.template_id = tpl
    ) x
    where x.prod = x.a * x.b
      and x.a between v_min and v_max
      and x.b between v_min and v_max
  ) d;
  perform tests.ok(n_pairs = 10, '10 unique unordered pairs in range');

  res := public.api_generate_multiplication_test(
    tid, subj, 3, 5, 'graded'::public.assessment_mode, 'G9 L5'
  );
  tpl := (res->>'templateId')::uuid;
  perform tests.ok((res->>'questionCount')::int = 30, 'level5 with squares = 30');

  select
    bool_or(prompt->>'text' ~ '11\s*×\s*11'),
    bool_or(prompt->>'text' ~ '12\s*×\s*12')
  into has_sq11, has_sq12
  from public.assessment_questions where template_id = tpl;
  perform tests.ok(has_sq11 and has_sq12, 'includes 11×11 and 12×12');

  res := public.api_generate_multiplication_test(
    tid, subj, 4, 1, 'practice'::public.assessment_mode, null
  );
  perform tests.ok((res->>'configGradeLevel')::int = 3, 'grade 4 falls back to 3');

  begin
    perform public.api_generate_multiplication_test(
      tid, subj, 1, 1, 'practice'::public.assessment_mode, null
    );
    perform tests.fail('grade 1 should not_found');
  exception when others then
    perform tests.ok(sqlerrm ilike '%not_found%', 'grade 1 not_found');
  end;

  begin
    perform public.api_generate_multiplication_test(
      sid, subj, 3, 1, 'practice'::public.assessment_mode, null
    );
    perform tests.fail('student should be rejected');
  exception when others then
    perform tests.ok(sqlerrm ilike '%not_found%', 'student rejected');
  end;
end;
$$;

select tests.ok(true, '97_g9_generate_multiplication completed');
rollback;

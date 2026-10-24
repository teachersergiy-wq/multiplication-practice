-- G5 (issue #43): RLS and role isolation. Tests only. No migration.
-- After R2, assessment_questions SELECT is owner-only; students get items via Edge Functions.

begin;

do $$
declare
  teacher_a uuid := 'a5a5a5a5-a5a5-a5a5-a5a5-a5a5a5a5a501';
  teacher_b uuid := 'b5b5b5b5-b5b5-b5b5-b5b5-b5b5b5b5b501';
  student_a uuid := 'c5c5c5c5-c5c5-c5c5-c5c5-c5c5c5c5c501';
  student_b uuid := 'd5d5d5d5-d5d5-d5d5-d5d5-d5d5d5d5d501';
  school_id uuid;
  class_a uuid;
  class_b uuid;
  subject_id uuid;
  tpl_pub uuid := 'e5e5e5e5-e5e5-e5e5-e5e5-e5e5e5e5e501';
  tpl_draft uuid := 'e5e5e5e5-e5e5-e5e5-e5e5-e5e5e5e5e502';
  tpl_b uuid := 'e5e5e5e5-e5e5-e5e5-e5e5-e5e5e5e5e503';
  tpl_grade uuid := 'e5e5e5e5-e5e5-e5e5-e5e5-e5e5e5e5e504';
  q_pub uuid := 'f5f5f5f5-f5f5-f5f5-f5f5-f5f5f5f5f501';
  q_b uuid := 'f5f5f5f5-f5f5-f5f5-f5f5-f5f5f5f5f502';
  asg_a uuid := '11111111-1111-1111-1111-111111111501';
  att_open uuid := '22222222-2222-2222-2222-222222222501';
  att_done uuid := '22222222-2222-2222-2222-222222222502';
  att_b uuid := '22222222-2222-2222-2222-222222222503';
begin
  perform tests.ensure_auth_user(teacher_a, 'g5-a@test.local');
  perform tests.ensure_auth_user(teacher_b, 'g5-b@test.local');
  perform tests.ensure_auth_user(student_a, 'g5-sa@test.local');
  perform tests.ensure_auth_user(student_b, 'g5-sb@test.local');

  insert into public.profiles (id, role, full_name, generated_nickname, student_login_code)
  values
    (teacher_a, 'teacher', 'G5 A', 'g5-teacher-a', null),
    (teacher_b, 'teacher', 'G5 B', 'g5-teacher-b', null),
    (student_a, 'student', 'G5 SA', 'g5-student-a', 'g5sa'),
    (student_b, 'student', 'G5 SB', 'g5-student-b', 'g5sb')
  on conflict (id) do nothing;

  insert into public.schools (name) values ('G5 School') returning id into school_id;
  insert into public.classes (school_id, name) values (school_id, 'G5 A') returning id into class_a;
  insert into public.classes (school_id, name) values (school_id, 'G5 B') returning id into class_b;
  insert into public.class_teachers (class_id, teacher_id) values (class_a, teacher_a), (class_b, teacher_b);
  insert into public.class_students (student_id, class_id) values (student_a, class_a), (student_b, class_b);

  select id into subject_id from public.subjects where code = 'mathematics' limit 1;

  insert into public.class_subjects (class_id, subject_id, grade_level)
  values (class_a, subject_id, 3), (class_b, subject_id, 3)
  on conflict do nothing;

  insert into public.assessment_templates (id, teacher_id, subject_id, grade_level, title, mode, status)
  values
    (tpl_pub, teacher_a, subject_id, 3, 'G5 published', 'graded', 'published'),
    (tpl_draft, teacher_a, subject_id, 3, 'G5 draft', 'graded', 'draft'),
    (tpl_b, teacher_b, subject_id, 3, 'G5 B published', 'graded', 'published'),
    (tpl_grade, teacher_a, subject_id, 4, 'G5 wrong grade', 'graded', 'published');

  insert into public.assessment_questions (id, template_id, position, question_type, prompt, choices, points)
  values
    (q_pub, tpl_pub, 1, 'true_false', '{"text":"2*2=4"}'::jsonb, '[]'::jsonb, 1),
    (q_b, tpl_b, 1, 'true_false', '{"text":"secret"}'::jsonb, '[]'::jsonb, 1);

  insert into private.assessment_answer_keys (question_id, answer_key, checker_version)
  values
    (q_pub, '{"type":"true_false","value":true}'::jsonb, 1),
    (q_b, '{"type":"true_false","value":false}'::jsonb, 1);

  insert into public.assessment_assignments (id, template_id, class_id, assigned_by)
  values (asg_a, tpl_pub, class_a, teacher_a);

  insert into public.assessment_attempts (id, assignment_id, student_id, status, finished_at, score, max_score, passed)
  values
    (att_open, asg_a, student_a, 'in_progress', null, null, null, null),
    (att_done, asg_a, student_a, 'completed', now(), 1, 1, true);

  insert into public.assessment_responses (attempt_id, question_id, response, is_correct, awarded_points)
  values
    (att_open, q_pub, '{"type":"true_false","value":true}'::jsonb, null, null),
    (att_done, q_pub, '{"type":"true_false","value":true}'::jsonb, true, 1);

  insert into public.assessment_assignments (template_id, class_id, assigned_by)
  values (tpl_b, class_b, teacher_b);
  insert into public.assessment_attempts (id, assignment_id, student_id, status, finished_at, score, max_score, passed)
  select att_b, a.id, student_b, 'completed', now(), 0, 1, false
  from public.assessment_assignments a
  where a.template_id = tpl_b and a.class_id = class_b;
  insert into public.assessment_responses (attempt_id, question_id, response, is_correct, awarded_points)
  values (att_b, q_b, '{"type":"true_false","value":true}'::jsonb, false, 0);

  perform set_config('tests.g5.teacher_a', teacher_a::text, true);
  perform set_config('tests.g5.teacher_b', teacher_b::text, true);
  perform set_config('tests.g5.student_a', student_a::text, true);
  perform set_config('tests.g5.student_b', student_b::text, true);
  perform set_config('tests.g5.class_a', class_a::text, true);
  perform set_config('tests.g5.class_b', class_b::text, true);
  perform set_config('tests.g5.tpl_pub', tpl_pub::text, true);
  perform set_config('tests.g5.tpl_draft', tpl_draft::text, true);
  perform set_config('tests.g5.tpl_b', tpl_b::text, true);
  perform set_config('tests.g5.tpl_grade', tpl_grade::text, true);
  perform set_config('tests.g5.q_pub', q_pub::text, true);
  perform set_config('tests.g5.q_b', q_b::text, true);
  perform set_config('tests.g5.subject', subject_id::text, true);
  perform set_config('tests.g5.att_open', att_open::text, true);
  perform set_config('tests.g5.att_done', att_done::text, true);
  perform set_config('tests.g5.att_b', att_b::text, true);
end;
$$;

-- 1. Student: no keys; no direct question rows (R2 owner-only SELECT); no foreign attempts/classes.
select tests.set_jwt(current_setting('tests.g5.student_a')::uuid);

select tests.throws(
  'select count(*) from private.assessment_answer_keys',
  'student must not select private.assessment_answer_keys'
);

select tests.ok(
  not exists (
    select 1 from public.assessment_questions q
    where q.id = current_setting('tests.g5.q_b')::uuid
  ),
  'student A does not see teacher B questions'
);

select tests.ok(
  not exists (
    select 1 from public.assessment_questions q
    where q.id = current_setting('tests.g5.q_pub')::uuid
  ),
  'student cannot SELECT assessment_questions even for assigned published test (Edge-only)'
);

select tests.ok(
  not exists (
    select 1 from public.assessment_attempts
    where id = current_setting('tests.g5.att_b')::uuid
  ),
  'student A does not see student B attempt'
);

select tests.ok(
  not exists (
    select 1 from public.classes where id = current_setting('tests.g5.class_b')::uuid
  ),
  'student A does not see class B'
);

select tests.throws(
  format(
    'update public.assessment_attempts set score = 99 where id = %L',
    current_setting('tests.g5.att_done')
  ),
  'student must not update attempts (no write grant)'
);

select tests.throws(
  format(
    'update public.assessment_responses set awarded_points = 99 where attempt_id = %L',
    current_setting('tests.g5.att_done')
  ),
  'student must not update responses (no write grant)'
);

-- 4. Graded scores: in-progress null; completed visible only to owner.
select tests.ok(
  not exists (
    select 1 from public.assessment_responses r
    where r.attempt_id = current_setting('tests.g5.att_open')::uuid
      and (r.is_correct is not null or r.awarded_points is not null)
  ),
  'in-progress graded response does not expose is_correct or awarded_points'
);

select tests.ok(
  exists (
    select 1 from public.assessment_responses r
    where r.attempt_id = current_setting('tests.g5.att_done')::uuid
      and r.is_correct is true and r.awarded_points = 1
  ),
  'completed attempt reveals scores only to the owning student'
);

select tests.ok(
  not exists (
    select 1 from public.assessment_responses r
    where r.attempt_id = current_setting('tests.g5.att_b')::uuid
  ),
  'student A does not see student B response scores'
);

-- Trigger: writing a score before finish must fail.
select tests.clear_jwt();
select tests.throws(
  format(
    $q$
      insert into public.assessment_responses (attempt_id, question_id, response, is_correct, awarded_points)
      values (%L, %L, '{"type":"true_false","value":false}'::jsonb, true, 1)
    $q$,
    current_setting('tests.g5.att_open'),
    current_setting('tests.g5.q_pub')
  ),
  'graded in_progress insert must reject is_correct/awarded_points'
);

-- 2. Teacher A isolation vs teacher B.
select tests.set_jwt(current_setting('tests.g5.teacher_a')::uuid);

select tests.ok(
  not exists (
    select 1 from public.assessment_templates t
    where t.id = current_setting('tests.g5.tpl_b')::uuid
  ),
  'teacher A does not see teacher B template'
);

select tests.ok(
  not exists (
    select 1 from public.class_students cs
    where cs.student_id = current_setting('tests.g5.student_b')::uuid
  ),
  'teacher A does not see teacher B student link'
);

select tests.ok(
  not exists (
    select 1 from public.assessment_attempts a
    where a.id = current_setting('tests.g5.att_b')::uuid
  ),
  'teacher A does not see teacher B student attempt'
);

select tests.throws(
  format(
    $q$
      insert into public.assessment_assignments (template_id, class_id, assigned_by)
      values (%L, %L, %L)
    $q$,
    current_setting('tests.g5.tpl_b'),
    current_setting('tests.g5.class_a'),
    current_setting('tests.g5.teacher_a')
  ),
  'cannot assign another teacher published template'
);

select tests.throws(
  format(
    $q$
      insert into public.assessment_assignments (template_id, class_id, assigned_by)
      values (%L, %L, %L)
    $q$,
    current_setting('tests.g5.tpl_draft'),
    current_setting('tests.g5.class_a'),
    current_setting('tests.g5.teacher_a')
  ),
  'cannot assign a draft template'
);

select tests.throws(
  format(
    $q$
      insert into public.assessment_assignments (template_id, class_id, assigned_by)
      values (%L, %L, %L)
    $q$,
    current_setting('tests.g5.tpl_grade'),
    current_setting('tests.g5.class_a'),
    current_setting('tests.g5.teacher_a')
  ),
  'cannot assign template with mismatched grade_level'
);

select tests.throws(
  format(
    $q$
      insert into public.assessment_assignments (template_id, class_id, assigned_by)
      values (%L, %L, %L)
    $q$,
    current_setting('tests.g5.tpl_pub'),
    current_setting('tests.g5.class_b'),
    current_setting('tests.g5.teacher_a')
  ),
  'cannot assign to a class the teacher does not manage'
);

-- 5. Published immutable; draft owner cannot SET status=published (R3 WITH CHECK).
select tests.set_jwt(current_setting('tests.g5.teacher_a')::uuid);
set local role authenticated;

select tests.updates_zero_rows(
  format(
    'update public.assessment_templates set title = %L where id = %L',
    'hacked published',
    current_setting('tests.g5.tpl_pub')
  ),
  'owner must not update a published template'
);

select tests.updates_zero_rows(
  format(
    'update public.assessment_questions set prompt = %L::jsonb where id = %L',
    '{"text":"hacked"}',
    current_setting('tests.g5.q_pub')
  ),
  'owner must not update questions of a published template'
);

-- D3: publishing via client UPDATE must fail (WITH CHECK status = draft) or affect 0 rows.
do $$
begin
  begin
    update public.assessment_templates
       set status = 'published'
     where id = current_setting('tests.g5.tpl_draft')::uuid;
    if found then
      perform tests.fail('draft owner must not publish via client UPDATE (row changed)');
    end if;
  exception
    when insufficient_privilege then null;
    when others then
      if sqlerrm not like '%policy%' and sqlerrm not like '%permission%' and sqlerrm not like '%check%' then
        perform tests.fail('unexpected error publishing draft: ' || sqlerrm);
      end if;
  end;
end;
$$;

reset role;
select tests.clear_jwt();

select tests.ok(
  exists (
    select 1 from public.assessment_templates
    where id = current_setting('tests.g5.tpl_draft')::uuid and status = 'draft'
  ),
  'draft remains draft after client publish attempt'
);

select tests.set_jwt(current_setting('tests.g5.student_a')::uuid);
set local role authenticated;
select tests.updates_zero_rows(
  format(
    'update public.assessment_templates set status = %L where id = %L',
    'draft',
    current_setting('tests.g5.tpl_pub')
  ),
  'student must not change template status'
);
reset role;
select tests.clear_jwt();

-- 3. anon: no table access and no api_/private execute.
set local role anon;
select tests.throws(
  'select count(*) from public.assessment_templates',
  'anon select templates must fail'
);
select tests.throws(
  'select public.api_is_allowed_teacher(''x@test.local'')',
  'anon must not execute public.api_is_allowed_teacher'
);
select tests.throws(
  'select private.can_read_template(''00000000-0000-0000-0000-000000000001'')',
  'anon must not execute private.can_read_template'
);
reset role;

-- 6. EXECUTE allowlist (policy helpers only for authenticated; anon none).
-- Exclude trigger return type and the tests helper schema.
select tests.ok(
  not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_type t on t.oid = p.prorettype
    where n.nspname in ('public', 'private')
      and t.typname <> 'trigger'
      and p.prokind = 'f'
      and (
        has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('authenticated', p.oid, 'execute')
      )
      and not (
        n.nspname = 'private'
        and p.proname in (
          'can_manage_class',
          'is_class_student',
          'owns_template',
          'can_read_template'
        )
        and has_function_privilege('authenticated', p.oid, 'execute')
        and not has_function_privilege('anon', p.oid, 'execute')
      )
  ),
  'only the four private policy helpers are executable by authenticated; anon executes none'
);

select tests.clear_jwt();
select tests.ok(true, '93_g5_rls_isolation completed');

rollback;

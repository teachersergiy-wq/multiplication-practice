-- R2/R3 privilege + WITH CHECK draft (catalog + SET LOCAL ROLE like 10_grants).
begin;

select tests.ok(
  not has_table_privilege('authenticated', 'public.assessment_questions', 'insert'),
  'authenticated cannot INSERT assessment_questions'
);
select tests.ok(
  not has_table_privilege('authenticated', 'public.assessment_questions', 'update'),
  'authenticated cannot UPDATE assessment_questions'
);
select tests.ok(
  not has_table_privilege('authenticated', 'public.assessment_questions', 'delete'),
  'authenticated cannot DELETE assessment_questions'
);

do $$
declare
  teacher_id uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa20';
  subject_id uuid;
  template_id uuid := 'dddddddd-dddd-dddd-dddd-dddddddddd20';
begin
  perform tests.ensure_auth_user(teacher_id, 'r2-t@test.local');
  insert into public.profiles (id, role, full_name, generated_nickname)
  values (teacher_id, 'teacher', 'R2 T', 'r2-t')
  on conflict (id) do nothing;
  select id into subject_id from public.subjects where code = 'mathematics' limit 1;
  insert into public.assessment_templates (id, teacher_id, subject_id, grade_level, title, status)
  values (template_id, teacher_id, subject_id, 3, 'R2 draft', 'draft');
  perform set_config('tests.teacher_id', teacher_id::text, true);
  perform set_config('tests.template_id', template_id::text, true);
end;
$$;

-- Publishing a draft directly is rejected by the RLS WITH CHECK policy.
select tests.set_jwt(current_setting('tests.teacher_id')::uuid);
set local role authenticated;
do $$
begin
  update public.assessment_templates
     set status = 'published'
   where id = current_setting('tests.template_id')::uuid;
  perform tests.fail('authenticated must not set status=published');
exception
  when insufficient_privilege then null;
end;
$$;
reset role;
select tests.clear_jwt();

select tests.ok(
  exists (
    select 1 from public.assessment_templates
    where id = current_setting('tests.template_id')::uuid and status = 'draft'
  ),
  'template remains draft'
);

rollback;

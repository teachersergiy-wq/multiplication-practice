-- R1: ordering and matching enum values accept inserts (as table owner / postgres).
begin;

do $$
declare
  teacher_id uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa10';
  subject_id uuid;
  template_id uuid := 'dddddddd-dddd-dddd-dddd-dddddddddd10';
begin
  perform tests.ensure_auth_user(teacher_id, 'r1-teacher@test.local');

  insert into public.profiles (id, role, full_name, generated_nickname)
  values (teacher_id, 'teacher', 'R1 Teacher', 'r1-t')
  on conflict (id) do nothing;

  select id into subject_id from public.subjects where code = 'mathematics' limit 1;

  insert into public.assessment_templates (id, teacher_id, subject_id, grade_level, title, status)
  values (template_id, teacher_id, subject_id, 3, 'R1 types', 'draft');

  insert into public.assessment_questions (template_id, position, question_type, prompt, choices, points)
  values
    (template_id, 1, 'ordering', '{"text":"order"}'::jsonb, '[]'::jsonb, 1),
    (template_id, 2, 'matching', '{"text":"match"}'::jsonb, '[]'::jsonb, 1);

  perform tests.ok(
    (select count(*) from public.assessment_questions q
     where q.template_id = template_id and q.question_type in ('ordering', 'matching')) = 2,
    'ordering and matching questions insert'
  );
end;
$$;

rollback;

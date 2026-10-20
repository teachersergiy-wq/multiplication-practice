begin;

-- Privilege checks only (isolate whether migration applied)
select tests.ok(
  exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'api_submit_answer'
  ),
  'api_submit_answer exists'
);

select tests.ok(
  not has_function_privilege('authenticated', 'public.api_submit_answer(uuid,uuid,uuid,jsonb)', 'execute'),
  'authenticated cannot submit_answer'
);

select tests.ok(
  has_function_privilege('service_role', 'public.api_start_attempt(uuid,uuid)', 'execute'),
  'service_role can start'
);

select tests.ok(
  has_function_privilege('service_role', 'public.api_finish_attempt(uuid,uuid)', 'execute'),
  'service_role can finish'
);

-- New finalize signature exists (uuid, boolean)
select tests.ok(
  exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_type t on t.oid = p.prorettype
    where n.nspname = 'private' and p.proname = 'finalize_attempt'
      and p.pronargs = 2
  ),
  'finalize_attempt(uuid,boolean) exists'
);

-- Integer rejection at publish (settings only)
do $$
declare
  tid uuid := 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a101';
  subj uuid;
  tpl uuid := 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a120';
  qid uuid;
  err text;
begin
  perform tests.ensure_auth_user(tid, 'g6b-int-teacher@test.local');
  insert into public.profiles (id, role, full_name, generated_nickname)
  values (tid, 'teacher', 'G6b Int Teacher', 'G6BINTT')
  on conflict (id) do nothing;

  select id into subj from public.subjects where code = 'mathematics' limit 1;
  perform tests.ok(subj is not null, 'mathematics subject exists');

  insert into public.assessment_templates (
    id, teacher_id, subject_id, grade_level, title, mode, status, settings
  ) values (
    tpl, tid, subj, 3, 'G6b frac maxErrors',
    'practice', 'draft', '{"maxErrors": 1.5}'::jsonb
  ) on conflict (id) do update set settings = excluded.settings, status = 'draft';

  qid := private.save_question_with_key(
    tpl, null, 1, 'true_false',
    '{"text":"ok?"}'::jsonb, '[]'::jsonb, 1, null,
    '{"type":"true_false","value":true}'::jsonb
  );
  perform tests.ok(qid is not null, 'saved question');

  begin
    perform public.api_publish_assessment(tpl, tid);
    perform tests.fail('publish with fractional maxErrors should fail');
  exception when others then
    err := SQLERRM;
    perform tests.ok(
      err ilike '%maxErrors%' or err ilike '%incomplete%',
      'fractional maxErrors rejected'
    );
  end;
end;
$$;

select tests.ok(true, '91_g6b_attempt_fixes completed');
rollback;

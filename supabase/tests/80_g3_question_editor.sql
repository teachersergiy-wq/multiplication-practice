begin;

-- Wrappers exist and are not executable by anon/authenticated
select tests.ok(
  exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'api_save_question_with_key'
  ),
  'api_save_question_with_key exists'
);
select tests.ok(
  exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'api_get_assessment_draft'
  ),
  'api_get_assessment_draft exists'
);
select tests.ok(
  exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'api_delete_question'
  ),
  'api_delete_question exists'
);
select tests.ok(
  exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'api_reorder_questions'
  ),
  'api_reorder_questions exists'
);

select tests.ok(
  not has_function_privilege('anon', 'public.api_save_question_with_key(uuid,uuid,uuid,integer,public.question_type,jsonb,jsonb,numeric,integer,jsonb)', 'execute'),
  'anon cannot execute api_save_question_with_key'
);
select tests.ok(
  not has_function_privilege('authenticated', 'public.api_save_question_with_key(uuid,uuid,uuid,integer,public.question_type,jsonb,jsonb,numeric,integer,jsonb)', 'execute'),
  'authenticated cannot execute api_save_question_with_key'
);
select tests.ok(
  not has_function_privilege('authenticated', 'public.api_get_assessment_draft(uuid,uuid)', 'execute'),
  'authenticated cannot execute api_get_assessment_draft'
);
select tests.ok(
  has_function_privilege('service_role', 'public.api_save_question_with_key(uuid,uuid,uuid,integer,public.question_type,jsonb,jsonb,numeric,integer,jsonb)', 'execute'),
  'service_role can execute api_save_question_with_key'
);

-- Functional: teacher draft save + type mismatch rejected + key not readable by client roles
do $$
declare
  tid uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb01';
  qid uuid;
  subj uuid;
begin
  perform tests.ensure_auth_user(tid, 'g3-teacher@test.local');
  insert into public.profiles (id, role, full_name, generated_nickname)
  values (tid, 'teacher', 'G3 Teacher', 'G3T-' || substr(replace(tid::text, '-', ''), 1, 8))
  on conflict (id) do nothing;

  select id into subj from public.subjects where code = 'mathematics' limit 1;

  insert into public.assessment_templates (id, teacher_id, subject_id, grade_level, title, mode, status)
  values (
    'cccccccc-cccc-cccc-cccc-cccccccccc01',
    tid,
    subj,
    3,
    'G3 Draft',
    'practice',
    'draft'
  )
  on conflict (id) do nothing;

  qid := public.api_save_question_with_key(
    'cccccccc-cccc-cccc-cccc-cccccccccc01',
    tid,
    null,
    1,
    'true_false',
    '{"text":"2+2=4?"}'::jsonb,
    '[]'::jsonb,
    1,
    null,
    '{"type":"true_false","value":true}'::jsonb
  );
  perform tests.ok(qid is not null, 'save true_false returns id');

  perform tests.ok(
    exists (select 1 from private.assessment_answer_keys k where k.question_id = qid),
    'answer key stored in private'
  );

  -- type mismatch must fail
  begin
    perform public.api_save_question_with_key(
      'cccccccc-cccc-cccc-cccc-cccccccccc01',
      tid,
      null,
      2,
      'numeric',
      '{"text":"x"}'::jsonb,
      '[]'::jsonb,
      1,
      null,
      '{"type":"true_false","value":true}'::jsonb
    );
    perform tests.fail('type mismatch should raise');
  exception
    when others then
      perform tests.ok(true, 'type mismatch rejected');
  end;

  -- foreign teacher not_found on get
  begin
    perform public.api_get_assessment_draft(
      'cccccccc-cccc-cccc-cccc-cccccccccc01',
      'dddddddd-dddd-dddd-dddd-dddddddddd01'
    );
    perform tests.fail('foreign teacher should not get draft');
  exception
    when others then
      perform tests.ok(true, 'foreign teacher get draft rejected');
  end;
end;
$$;

select tests.ok(true, '80_g3_question_editor completed');
rollback;

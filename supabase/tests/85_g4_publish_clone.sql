begin;

select tests.ok(
  exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'api_publish_assessment'
  ),
  'api_publish_assessment exists'
);
select tests.ok(
  exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'api_clone_assessment'
  ),
  'api_clone_assessment exists'
);
select tests.ok(
  not has_function_privilege('authenticated', 'public.api_publish_assessment(uuid,uuid)', 'execute'),
  'authenticated cannot publish'
);
select tests.ok(
  not has_function_privilege('anon', 'public.api_clone_assessment(uuid,uuid)', 'execute'),
  'anon cannot clone'
);
select tests.ok(
  has_function_privilege('service_role', 'public.api_publish_assessment(uuid,uuid)', 'execute'),
  'service_role can publish'
);

do $$
declare
  tid uuid := 'eeeeeeee-eeee-eeee-eeee-eeeeeeee0001';
  tid2 uuid := 'eeeeeeee-eeee-eeee-eeee-eeeeeeee0002';
  tpl uuid := 'ffffffff-ffff-ffff-ffff-ffffffffff01';
  subj uuid;
  qid uuid;
  pub jsonb;
  cloned jsonb;
  new_tpl uuid;
  key_cnt integer;
begin
  perform tests.ensure_auth_user(tid, 'g4-teacher@test.local');
  perform tests.ensure_auth_user(tid2, 'g4-other@test.local');
  insert into public.profiles (id, role, full_name, generated_nickname)
  values
    (tid, 'teacher', 'G4 Teacher', 'G4T1'),
    (tid2, 'teacher', 'G4 Other', 'G4T2')
  on conflict (id) do nothing;

  select id into subj from public.subjects where code = 'mathematics' limit 1;

  insert into public.assessment_templates (id, teacher_id, subject_id, grade_level, title, mode, status)
  values (tpl, tid, subj, 3, 'G4 Source', 'practice', 'draft')
  on conflict (id) do nothing;

  -- incomplete: no questions
  begin
    perform public.api_publish_assessment(tpl, tid);
    perform tests.fail('publish without questions should fail');
  exception when others then
    perform tests.ok(SQLERRM ilike '%incomplete%', 'incomplete without questions');
  end;

  qid := private.save_question_with_key(
    tpl, null, 1, 'true_false',
    '{"text":"ok?"}'::jsonb, '[]'::jsonb, 1, null,
    '{"type":"true_false","value":true}'::jsonb
  );

  -- foreign teacher
  begin
    perform public.api_publish_assessment(tpl, tid2);
    perform tests.fail('foreign publish should fail');
  exception when others then
    perform tests.ok(SQLERRM ilike '%not_found%', 'foreign publish not_found');
  end;

  pub := public.api_publish_assessment(tpl, tid);
  perform tests.ok((pub->>'status') = 'published', 'publish sets published');
  perform tests.ok((pub->>'questionCount')::int = 1, 'questionCount 1');

  -- re-publish conflict
  begin
    perform public.api_publish_assessment(tpl, tid);
    perform tests.fail('re-publish should conflict');
  exception when others then
    perform tests.ok(SQLERRM ilike '%conflict%' or SQLERRM ilike '%draft%', 're-publish conflict');
  end;

  -- client cannot set status to published directly (RLS)
  perform tests.set_jwt(tid);
  perform tests.updates_zero_rows(
    format(
      'update public.assessment_templates set status = ''draft'' where id = %L',
      tpl
    ),
    'owner cannot unpublish via direct update when policy requires draft'
  );
  -- published row: update should affect 0 under draft-only policy
  perform tests.updates_zero_rows(
    format(
      'update public.assessment_templates set title = title || ''x'' where id = %L',
      tpl
    ),
    'published template not updatable by client'
  );
  perform tests.clear_jwt();

  cloned := public.api_clone_assessment(tpl, tid);
  new_tpl := (cloned->>'templateId')::uuid;
  perform tests.ok(new_tpl is not null and new_tpl <> tpl, 'clone new id');

  perform tests.ok(
    exists (
      select 1 from public.assessment_templates t
      where t.id = new_tpl and t.status = 'draft' and t.title like '%(копія)%'
    ),
    'clone is draft with copy suffix'
  );

  select count(*) into key_cnt
  from public.assessment_questions q
  join private.assessment_answer_keys k on k.question_id = q.id
  where q.template_id = new_tpl;
  perform tests.ok(key_cnt = 1, 'clone preserved answer keys');

  -- foreign clone
  begin
    perform public.api_clone_assessment(tpl, tid2);
    perform tests.fail('foreign clone should fail');
  exception when others then
    perform tests.ok(SQLERRM ilike '%not_found%', 'foreign clone not_found');
  end;
end;
$$;

select tests.ok(true, '85_g4_publish_clone completed');
rollback;

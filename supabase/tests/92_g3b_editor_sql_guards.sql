begin;

-- G3b: SQL owner/draft on save; delete first of ≥3 repacks; publish rejects bad choiceId

select tests.ok(
  has_function_privilege(
    'service_role',
    'public.api_save_question_with_key(uuid,uuid,uuid,integer,public.question_type,jsonb,jsonb,numeric,integer,jsonb)',
    'execute'
  ),
  'service_role can execute 10-arg api_save_question_with_key'
);

do $$
declare
  tid uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb42';
  foreign_tid uuid := 'dddddddd-dddd-dddd-dddd-dddddddddd42';
  tpl uuid := 'cccccccc-cccc-cccc-cccc-cccccccccc42';
  subj uuid;
  q1 uuid;
  q2 uuid;
  q3 uuid;
  positions int[];
  msg text;
begin
  perform tests.ensure_auth_user(tid, 'g3b-teacher@test.local');
  perform tests.ensure_auth_user(foreign_tid, 'g3b-foreign@test.local');

  insert into public.profiles (id, role, full_name, generated_nickname)
  values
    (tid, 'teacher', 'G3b Teacher', 'G3B-' || substr(replace(tid::text, '-', ''), 1, 8)),
    (foreign_tid, 'teacher', 'G3b Foreign', 'G3BF-' || substr(replace(foreign_tid::text, '-', ''), 1, 8))
  on conflict (id) do nothing;

  select id into subj from public.subjects where code = 'mathematics' limit 1;

  insert into public.assessment_templates (id, teacher_id, subject_id, grade_level, title, mode, status, settings)
  values (tpl, tid, subj, 3, 'G3b Draft', 'practice', 'draft', '{"passPercent":60}'::jsonb)
  on conflict (id) do update set status = 'draft', teacher_id = tid;

  -- 1) foreign teacher cannot save into another teacher's draft
  begin
    perform public.api_save_question_with_key(
      tpl, foreign_tid, null, 1, 'true_false',
      '{"text":"no"}'::jsonb, '[]'::jsonb, 1, null,
      '{"type":"true_false","value":false}'::jsonb
    );
    perform tests.fail('foreign teacher save should fail');
  exception
    when others then
      perform tests.ok(SQLERRM ilike '%not_found%', 'foreign teacher save -> not_found');
  end;

  -- own teacher can save three questions
  q1 := public.api_save_question_with_key(
    tpl, tid, null, 1, 'true_false',
    '{"text":"Q1"}'::jsonb, '[]'::jsonb, 1, null,
    '{"type":"true_false","value":true}'::jsonb
  );
  q2 := public.api_save_question_with_key(
    tpl, tid, null, 2, 'true_false',
    '{"text":"Q2"}'::jsonb, '[]'::jsonb, 1, null,
    '{"type":"true_false","value":false}'::jsonb
  );
  q3 := public.api_save_question_with_key(
    tpl, tid, null, 3, 'true_false',
    '{"text":"Q3"}'::jsonb, '[]'::jsonb, 1, null,
    '{"type":"true_false","value":true}'::jsonb
  );
  perform tests.ok(q1 is not null and q2 is not null and q3 is not null, 'three questions saved');

  -- 2) delete first of ≥3: positions re-dense 1..2 without unique violation
  perform public.api_delete_question(q1, tid);
  select array_agg(position order by position) into positions
  from public.assessment_questions where template_id = tpl;
  perform tests.ok(positions = array[1, 2], 'after delete first, positions are 1,2');
  perform tests.ok(
    not exists (select 1 from public.assessment_questions where id = q1),
    'first question removed'
  );

  -- cannot save into published template
  update public.assessment_templates set status = 'published' where id = tpl;
  begin
    perform public.api_save_question_with_key(
      tpl, tid, null, 3, 'true_false',
      '{"text":"no"}'::jsonb, '[]'::jsonb, 1, null,
      '{"type":"true_false","value":true}'::jsonb
    );
    perform tests.fail('save on published should fail');
  exception
    when others then
      perform tests.ok(SQLERRM ilike '%conflict%', 'save on published -> conflict');
  end;
  update public.assessment_templates set status = 'draft' where id = tpl;

  -- 3) publish rejects choiceId not in choices (G6b guard exercised)
  perform public.api_save_question_with_key(
    tpl, tid, null, 3, 'single_choice',
    '{"text":"pick"}'::jsonb,
    '[{"id":"a","text":"A"},{"id":"b","text":"B"}]'::jsonb,
    1, null,
    '{"type":"single_choice","choiceId":"zzz"}'::jsonb
  );

  begin
    perform public.api_publish_assessment(tpl, tid);
    perform tests.fail('publish with bad choiceId should fail');
  exception
    when others then
      msg := SQLERRM;
      perform tests.ok(
        msg ilike '%incomplete_assessment%' or msg ilike '%choiceId%',
        'publish bad choiceId rejected: ' || left(msg, 80)
      );
  end;
end;
$$;

select tests.ok(true, '92_g3b_editor_sql_guards completed');
rollback;

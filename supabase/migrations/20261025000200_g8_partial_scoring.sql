-- G8 (issue #67): partial credit for multiple_choice, ordering, matching (checker_version 2).
-- Depends on G6c finalize_attempt counters. NOT applied to production by agents.

create or replace function private.score_response(
  p_question_type public.question_type,
  p_answer_key jsonb,
  p_response jsonb,
  p_points numeric
)
returns table(is_correct boolean, awarded_points numeric)
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_ok boolean := false;
  v_f numeric := 0;
  v_resp_type text;
  a text[];
  b text[];
  v_num numeric;
  v_tol numeric;
  v_text text;
  v_acc text;
  v_case boolean;
  n_correct integer;
  k_hit integer;
  w_wrong integer;
  i integer;
  v_len integer;
  v_match_ok integer;
  v_match_total integer;
  kp jsonb;
begin
  if p_answer_key is null or p_response is null then
    return query select false, 0::numeric;
    return;
  end if;
  v_resp_type := p_response->>'type';
  if v_resp_type is distinct from p_question_type::text then
    return query select false, 0::numeric;
    return;
  end if;

  if p_question_type = 'true_false' then
    v_ok := (p_response->'value') = (p_answer_key->'value');
    v_f := case when v_ok then 1 else 0 end;

  elsif p_question_type = 'single_choice' then
    v_ok := (p_response->>'choiceId') is not distinct from (p_answer_key->>'choiceId');
    v_f := case when v_ok then 1 else 0 end;

  elsif p_question_type = 'multiple_choice' then
    select coalesce(array_agg(distinct x order by x), '{}') into b
    from jsonb_array_elements_text(coalesce(p_answer_key->'choiceIds', '[]'::jsonb)) as x;
    select coalesce(array_agg(distinct x order by x), '{}') into a
    from jsonb_array_elements_text(coalesce(p_response->'choiceIds', '[]'::jsonb)) as x;
    n_correct := cardinality(b);
    if n_correct < 1 then
      v_f := 0;
    else
      select count(*)::integer into k_hit
      from unnest(a) x where x = any (b);
      select count(*)::integer into w_wrong
      from unnest(a) x where not (x = any (b));
      v_f := greatest(0::numeric, (k_hit - w_wrong)::numeric / n_correct::numeric);
    end if;
    v_ok := (v_f = 1);

  elsif p_question_type = 'ordering' then
    select coalesce(array_agg(x order by ordinality), '{}') into a
    from jsonb_array_elements_text(coalesce(p_response->'order', '[]'::jsonb))
      with ordinality as t(x, ordinality);
    select coalesce(array_agg(x order by ordinality), '{}') into b
    from jsonb_array_elements_text(coalesce(p_answer_key->'order', '[]'::jsonb))
      with ordinality as t(x, ordinality);
    v_len := cardinality(b);
    if v_len < 1 then
      v_f := 0;
    else
      k_hit := 0;
      for i in 1..v_len loop
        if i <= cardinality(a) and a[i] is not distinct from b[i] then
          k_hit := k_hit + 1;
        end if;
      end loop;
      v_f := k_hit::numeric / v_len::numeric;
    end if;
    v_ok := (v_f = 1);

  elsif p_question_type = 'matching' then
    v_match_total := jsonb_array_length(coalesce(p_answer_key->'pairs', '[]'::jsonb));
    if v_match_total < 1 then
      v_f := 0;
    else
      v_match_ok := 0;
      for kp in
        select value from jsonb_array_elements(coalesce(p_answer_key->'pairs', '[]'::jsonb)) as t(value)
      loop
        if exists (
          select 1
          from jsonb_array_elements(coalesce(p_response->'pairs', '[]'::jsonb)) as t(value)
          where value->>'leftId' = kp->>'leftId'
            and value->>'rightId' = kp->>'rightId'
        ) then
          v_match_ok := v_match_ok + 1;
        end if;
      end loop;
      v_f := v_match_ok::numeric / v_match_total::numeric;
    end if;
    v_ok := (v_f = 1);

  elsif p_question_type = 'numeric' then
    v_text := replace(trim(coalesce(p_response->>'text', '')), ',', '.');
    if v_text ~ '^[+-]?\d+([.]\d+)?$' then
      v_num := v_text::numeric;
      v_tol := coalesce((p_answer_key->>'tolerance')::numeric, 0) + 1e-9;
      v_ok := abs(v_num - (p_answer_key->>'value')::numeric) <= v_tol;
    else
      v_ok := false;
    end if;
    v_f := case when v_ok then 1 else 0 end;

  elsif p_question_type = 'short_answer' then
    v_text := trim(coalesce(p_response->>'text', ''));
    v_case := coalesce((p_answer_key->>'caseSensitive')::boolean, false);
    if not v_case then
      v_text := lower(v_text);
    end if;
    v_text := regexp_replace(v_text, '\s+', ' ', 'g');
    v_ok := false;
    for v_acc in
      select jsonb_array_elements_text(coalesce(p_answer_key->'accepted', '[]'::jsonb))
    loop
      v_acc := trim(v_acc);
      if not v_case then v_acc := lower(v_acc); end if;
      v_acc := regexp_replace(v_acc, '\s+', ' ', 'g');
      if v_acc = v_text then
        v_ok := true;
        exit;
      end if;
    end loop;
    v_f := case when v_ok then 1 else 0 end;
  end if;

  return query select
    coalesce(v_ok, false),
    round(coalesce(p_points, 0) * coalesce(v_f, 0), 2);
end;
$$;

revoke all on function private.score_response(public.question_type, jsonb, jsonb, numeric)
  from public, anon, authenticated;
grant execute on function private.score_response(public.question_type, jsonb, jsonb, numeric)
  to service_role;

update private.assessment_answer_keys k
set checker_version = 2
from public.assessment_questions q
where k.question_id = q.id
  and q.question_type in ('multiple_choice', 'ordering', 'matching')
  and k.checker_version is distinct from 2;

create or replace function private.save_question_with_key(
  p_template_id uuid,
  p_teacher_id uuid,
  p_question_id uuid,
  p_position integer,
  p_question_type public.question_type,
  p_prompt jsonb,
  p_choices jsonb,
  p_points numeric,
  p_time_limit_seconds integer,
  p_answer_key jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_id uuid;
  v_owner uuid;
  v_status public.assessment_status;
  v_version integer;
begin
  if p_answer_key is null then
    raise exception 'answer_key required';
  end if;

  select teacher_id, status into v_owner, v_status
  from public.assessment_templates
  where id = p_template_id
  for update;

  if v_owner is null or v_owner is distinct from p_teacher_id then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_status is distinct from 'draft' then
    raise exception 'conflict: template not draft' using errcode = 'P0001';
  end if;

  if p_question_id is null then
    insert into public.assessment_questions (
      template_id, position, question_type, prompt, choices, points, time_limit_seconds
    ) values (
      p_template_id, p_position, p_question_type, p_prompt, coalesce(p_choices, '[]'::jsonb),
      coalesce(p_points, 1), p_time_limit_seconds
    ) returning id into v_id;
  else
    update public.assessment_questions set
      position = p_position,
      question_type = p_question_type,
      prompt = p_prompt,
      choices = coalesce(p_choices, '[]'::jsonb),
      points = coalesce(p_points, 1),
      time_limit_seconds = p_time_limit_seconds
    where id = p_question_id and template_id = p_template_id
    returning id into v_id;
    if v_id is null then
      raise exception 'not_found' using errcode = 'P0001';
    end if;
  end if;

  v_version := case
    when p_question_type in ('multiple_choice', 'ordering', 'matching') then 2
    else 1
  end;

  insert into private.assessment_answer_keys (question_id, answer_key, checker_version)
  values (v_id, p_answer_key, v_version)
  on conflict (question_id) do update
    set answer_key = excluded.answer_key,
        checker_version = excluded.checker_version;

  return v_id;
end;
$$;

revoke all on function private.save_question_with_key(
  uuid, uuid, uuid, integer, public.question_type, jsonb, jsonb, numeric, integer, jsonb
) from public, anon, authenticated;
grant execute on function private.save_question_with_key(
  uuid, uuid, uuid, integer, public.question_type, jsonb, jsonb, numeric, integer, jsonb
) to service_role;

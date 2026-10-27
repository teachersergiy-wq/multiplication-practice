-- G12b/c: competitive run lifecycle + leaderboards.
-- Do NOT apply to production from agents; owner applies after review.
-- No temporary tables; no DELETE without WHERE.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function private.competitive_student_grade(p_student_id uuid)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select cs.grade_level
  from public.class_students m
  join public.class_subjects cs on cs.class_id = m.class_id
  where m.student_id = p_student_id
  order by cs.grade_level
  limit 1;
$$;

create or replace function private.competitive_limit_ms(p_settings jsonb, p_score integer)
returns integer
language sql
immutable
as $$
  select greatest(
    coalesce((p_settings->>'minLimitMs')::int, 3500),
    coalesce((p_settings->>'startLimitMs')::int, 8000)
      - (greatest(p_score, 0) / greatest(coalesce((p_settings->>'stepEvery')::int, 5), 1))
        * coalesce((p_settings->>'stepMs')::int, 300)
  );
$$;

create or replace function private.competitive_issue_question(
  p_run_id uuid,
  p_topic_code text,
  p_score integer,
  p_settings jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_qid uuid := gen_random_uuid();
  v_a int;
  v_b int;
  v_prompt text;
  v_key int;
  v_limit int;
  v_curve jsonb;
  v_diff int := 1;
  v_pos int;
begin
  v_pos := greatest(p_score, 0) + 1;
  v_curve := coalesce(p_settings->'difficultyCurve', '[]'::jsonb);
  if jsonb_typeof(v_curve) = 'array' and jsonb_array_length(v_curve) >= v_pos then
    v_diff := greatest(1, least(5, coalesce((v_curve->>(v_pos - 1))::int, 1)));
  elsif v_pos > 78 then
    v_diff := 5;
  end if;

  -- multiplication_table: after 60 correct → division pairs; else multiply.
  if p_topic_code = 'multiplication_table' and p_score >= 60 then
    v_b := 1 + (v_diff); -- 2..6 roughly
    v_b := least(10, greatest(1, v_b + floor(random() * 3)::int));
    v_a := v_b * (1 + floor(random() * (1 + v_diff * 2))::int);
    v_a := least(100, v_a);
    v_prompt := v_a::text || ' ÷ ' || v_b::text;
    v_key := v_a / v_b;
  else
    v_a := least(12, greatest(1, v_diff + floor(random() * (2 + v_diff))::int));
    v_b := least(12, greatest(1, v_diff + floor(random() * (2 + v_diff))::int));
    v_prompt := v_a::text || ' × ' || v_b::text;
    v_key := v_a * v_b;
  end if;

  v_limit := private.competitive_limit_ms(p_settings, p_score);

  insert into private.competitive_run_state (
    run_id, question_id, prompt_text, answer_key, issued_at, limit_ms, updated_at
  ) values (
    p_run_id, v_qid, v_prompt,
    jsonb_build_object('type', 'numeric', 'value', v_key),
    now(), v_limit, now()
  )
  on conflict (run_id) do update set
    question_id = excluded.question_id,
    prompt_text = excluded.prompt_text,
    answer_key = excluded.answer_key,
    issued_at = excluded.issued_at,
    limit_ms = excluded.limit_ms,
    updated_at = now();

  return jsonb_build_object(
    'id', v_qid,
    'promptText', v_prompt,
    'type', 'numeric',
    'limitMs', v_limit
  );
end;
$$;

create or replace function private.competitive_finish_run(
  p_run_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_run public.competitive_runs%rowtype;
  v_dur int;
  v_best public.competitive_best%rowtype;
  v_is_pb boolean := false;
  v_qualified jsonb := '[]'::jsonb;
  v_level_count int;
  v_settings jsonb;
begin
  select * into v_run from public.competitive_runs where id = p_run_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_run.status <> 'in_progress' then
    -- idempotent re-read
    return jsonb_build_object(
      'runId', v_run.id,
      'score', v_run.score,
      'durationMs', coalesce(v_run.duration_ms, 0),
      'isPersonalBest', false,
      'qualified', '[]'::jsonb
    );
  end if;

  v_dur := greatest(0, (extract(epoch from (now() - v_run.started_at)) * 1000)::int);

  update public.competitive_runs
  set status = p_status,
      finished_at = now(),
      duration_ms = v_dur
  where id = p_run_id;

  select settings into v_settings from public.competitive_topics where code = v_run.topic_code;
  v_level_count := coalesce((v_settings->>'levelCount')::int, 6);

  -- Update best only for Super (last) level
  if v_run.level_number = v_level_count then
    select * into v_best
    from public.competitive_best
    where student_id = v_run.student_id and topic_code = v_run.topic_code;

    if not found then
      insert into public.competitive_best (
        student_id, topic_code, best_score, best_duration_ms, best_at, attempt_count, max_level_passed
      ) values (
        v_run.student_id, v_run.topic_code, v_run.score, v_dur, now(), 1,
        greatest(0, v_run.level_number - 1)
      );
      v_is_pb := true;
    else
      v_is_pb := (
        v_run.score > v_best.best_score
        or (v_run.score = v_best.best_score and v_dur < v_best.best_duration_ms)
      );
      update public.competitive_best
      set attempt_count = attempt_count + 1,
          best_score = case when v_is_pb then v_run.score else best_score end,
          best_duration_ms = case when v_is_pb then v_dur else best_duration_ms end,
          best_at = case when v_is_pb then now() else best_at end
      where student_id = v_run.student_id and topic_code = v_run.topic_code;
    end if;
  else
    -- finite level: count attempt; pass if score >= questionCount * passPercent/100
    insert into public.competitive_best (
      student_id, topic_code, best_score, best_duration_ms, best_at, attempt_count, max_level_passed
    ) values (
      v_run.student_id, v_run.topic_code, 0, 0, now(), 1, 0
    )
    on conflict (student_id, topic_code) do update
      set attempt_count = public.competitive_best.attempt_count + 1;

    -- unlock next if this run completed with enough correct
    if p_status = 'completed' then
      update public.competitive_best
      set max_level_passed = greatest(max_level_passed, v_run.level_number)
      where student_id = v_run.student_id and topic_code = v_run.topic_code;
    end if;
  end if;

  -- qualified rankings filled lightly at finish (top-10 check deferred to publish scopes)
  return jsonb_build_object(
    'runId', p_run_id,
    'score', v_run.score,
    'durationMs', v_dur,
    'isPersonalBest', v_is_pb,
    'qualified', v_qualified
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- G12b APIs
-- ---------------------------------------------------------------------------

create or replace function public.api_list_competitive_topics(p_student_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_grade int;
  v_topics jsonb := '[]'::jsonb;
  r record;
  v_best public.competitive_best%rowtype;
  v_settings jsonb;
  v_level_count int;
  v_levels jsonb;
  v_i int;
  v_unlocked boolean;
  v_passed boolean;
  v_endless boolean;
  v_fl jsonb;
  v_qc int;
  v_sec int;
begin
  if p_student_id is null then
    raise exception 'invalid_request: studentId required' using errcode = 'P0001';
  end if;
  if auth.uid() is not null and auth.uid() is distinct from p_student_id then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  v_grade := private.competitive_student_grade(p_student_id);
  if v_grade is null then
    return jsonb_build_object('topics', '[]'::jsonb);
  end if;

  for r in
    select * from public.competitive_topics t
    where t.active and t.grade_min <= v_grade and t.grade_max >= v_grade
    order by t.code
  loop
    v_settings := r.settings;
    v_level_count := coalesce((v_settings->>'levelCount')::int, 6);
    select * into v_best
    from public.competitive_best
    where student_id = p_student_id and topic_code = r.code;

    v_levels := '[]'::jsonb;
    for v_i in 1..v_level_count loop
      v_endless := (v_i = v_level_count);
      v_unlocked := (v_i = 1) or (coalesce(v_best.max_level_passed, 0) >= v_i - 1);
      v_passed := coalesce(v_best.max_level_passed, 0) >= v_i;
      v_qc := null;
      v_sec := null;
      if not v_endless then
        select elem into v_fl
        from jsonb_array_elements(coalesce(v_settings->'finiteLevels', '[]'::jsonb)) elem
        where (elem->>'levelNumber')::int = v_i
        limit 1;
        if v_fl is not null then
          v_qc := (v_fl->>'questionCount')::int;
          v_sec := (v_fl->>'secondsPerQuestion')::int;
        end if;
      end if;
      v_levels := v_levels || jsonb_build_array(jsonb_build_object(
        'levelNumber', v_i,
        'questionCount', to_jsonb(v_qc),
        'secondsPerQuestion', to_jsonb(v_sec),
        'unlocked', v_unlocked,
        'passed', v_passed,
        'isEndless', v_endless
      ));
    end loop;

    v_topics := v_topics || jsonb_build_array(jsonb_build_object(
      'code', r.code,
      'title', r.title,
      'gradeMin', r.grade_min,
      'gradeMax', r.grade_max,
      'levels', v_levels,
      'myBest', case
        when v_best.student_id is null then null
        else jsonb_build_object(
          'score', v_best.best_score,
          'durationMs', v_best.best_duration_ms,
          'attemptCount', v_best.attempt_count
        )
      end
    ));
  end loop;

  return jsonb_build_object('topics', v_topics);
end;
$$;

create or replace function public.api_start_competitive_run(
  p_student_id uuid,
  p_topic_code text,
  p_level_number int
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_topic public.competitive_topics%rowtype;
  v_grade int;
  v_settings jsonb;
  v_level_count int;
  v_best public.competitive_best%rowtype;
  v_daily int;
  v_run_id uuid;
  v_q jsonb;
  v_daily_limit int;
begin
  if p_student_id is null or p_topic_code is null or p_level_number is null then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  if auth.uid() is not null and auth.uid() is distinct from p_student_id then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  select * into v_topic from public.competitive_topics where code = p_topic_code and active;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  v_grade := private.competitive_student_grade(p_student_id);
  if v_grade is null or v_grade < v_topic.grade_min or v_grade > v_topic.grade_max then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  v_settings := v_topic.settings;
  v_level_count := coalesce((v_settings->>'levelCount')::int, 6);
  if p_level_number < 1 or p_level_number > v_level_count then
    raise exception 'invalid_request: levelNumber' using errcode = 'P0001';
  end if;

  select * into v_best
  from public.competitive_best
  where student_id = p_student_id and topic_code = p_topic_code;

  if p_level_number > 1 and coalesce(v_best.max_level_passed, 0) < p_level_number - 1 then
    raise exception 'forbidden: level locked' using errcode = 'P0001';
  end if;

  v_daily_limit := coalesce((v_settings->>'dailyRunLimit')::int, 200);
  select count(*)::int into v_daily
  from public.competitive_runs
  where student_id = p_student_id
    and started_at >= date_trunc('day', now() at time zone 'utc')
    and started_at < date_trunc('day', now() at time zone 'utc') + interval '1 day';
  if v_daily >= v_daily_limit then
    raise exception 'conflict: daily run limit' using errcode = 'P0001';
  end if;

  -- abandon any previous in-progress run for this student/topic
  update public.competitive_runs
  set status = 'abandoned',
      finished_at = now(),
      duration_ms = greatest(0, (extract(epoch from (now() - started_at)) * 1000)::int)
  where student_id = p_student_id
    and topic_code = p_topic_code
    and status = 'in_progress';

  insert into public.competitive_runs (student_id, topic_code, level_number, status, score, started_at)
  values (p_student_id, p_topic_code, p_level_number, 'in_progress', 0, now())
  returning id into v_run_id;

  v_q := private.competitive_issue_question(v_run_id, p_topic_code, 0, v_settings);

  return jsonb_build_object(
    'runId', v_run_id,
    'question', jsonb_build_object(
      'id', v_q->>'id',
      'promptText', v_q->>'promptText',
      'type', 'numeric'
    ),
    'limitMs', (v_q->>'limitMs')::int,
    'serverNow', now()
  );
end;
$$;

create or replace function public.api_submit_competitive_answer(
  p_student_id uuid,
  p_run_id uuid,
  p_question_id uuid,
  p_response jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_run public.competitive_runs%rowtype;
  v_state private.competitive_run_state%rowtype;
  v_topic public.competitive_topics%rowtype;
  v_settings jsonb;
  v_min_answer int;
  v_grace int;
  v_elapsed_ms int;
  v_key numeric;
  v_val numeric;
  v_correct boolean;
  v_result jsonb;
  v_q jsonb;
  v_level_count int;
  v_finite_count int;
  v_fl jsonb;
begin
  if p_student_id is null or p_run_id is null or p_question_id is null then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  if auth.uid() is not null and auth.uid() is distinct from p_student_id then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  select * into v_run from public.competitive_runs where id = p_run_id for update;
  if not found or v_run.student_id is distinct from p_student_id then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_run.status <> 'in_progress' then
    raise exception 'conflict: run finished' using errcode = 'P0001';
  end if;

  select * into v_state from private.competitive_run_state where run_id = p_run_id;
  if not found or v_state.question_id is distinct from p_question_id then
    raise exception 'invalid_request: question mismatch' using errcode = 'P0001';
  end if;

  select * into v_topic from public.competitive_topics where code = v_run.topic_code;
  v_settings := v_topic.settings;
  v_min_answer := coalesce((v_settings->>'minAnswerMs')::int, 300);
  v_grace := coalesce((v_settings->>'graceMs')::int, 1000);
  v_elapsed_ms := (extract(epoch from (now() - v_state.issued_at)) * 1000)::int;

  if v_elapsed_ms < v_min_answer then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  -- timeout (limit + grace)
  if v_elapsed_ms > coalesce(v_state.limit_ms, 8000) + v_grace then
    v_result := private.competitive_finish_run(p_run_id, 'completed');
    return jsonb_build_object('finished', true, 'result', v_result);
  end if;

  if p_response is null or p_response->>'type' is distinct from 'numeric' then
    raise exception 'invalid_request: response' using errcode = 'P0001';
  end if;
  begin
    v_val := (p_response->>'value')::numeric;
  exception when others then
    raise exception 'invalid_request: value' using errcode = 'P0001';
  end;

  v_key := (v_state.answer_key->>'value')::numeric;
  v_correct := (v_val = v_key);

  v_level_count := coalesce((v_settings->>'levelCount')::int, 6);

  if not v_correct then
    v_result := private.competitive_finish_run(p_run_id, 'completed');
    return jsonb_build_object('finished', true, 'result', v_result);
  end if;

  -- correct
  update public.competitive_runs set score = score + 1 where id = p_run_id;
  v_run.score := v_run.score + 1;

  -- finite level completion
  if v_run.level_number < v_level_count then
    select elem into v_fl
    from jsonb_array_elements(coalesce(v_settings->'finiteLevels', '[]'::jsonb)) elem
    where (elem->>'levelNumber')::int = v_run.level_number
    limit 1;
    v_finite_count := coalesce((v_fl->>'questionCount')::int, 10);
    if v_run.score >= v_finite_count then
      v_result := private.competitive_finish_run(p_run_id, 'completed');
      return jsonb_build_object('finished', true, 'result', v_result);
    end if;
  end if;

  v_q := private.competitive_issue_question(p_run_id, v_run.topic_code, v_run.score, v_settings);
  return jsonb_build_object(
    'finished', false,
    'correct', true,
    'score', v_run.score,
    'question', jsonb_build_object(
      'id', v_q->>'id',
      'promptText', v_q->>'promptText',
      'type', 'numeric'
    ),
    'limitMs', (v_q->>'limitMs')::int
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- G12c APIs
-- ---------------------------------------------------------------------------

create or replace function public.api_publish_competitive_result(
  p_student_id uuid,
  p_run_id uuid,
  p_visibility text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_run public.competitive_runs%rowtype;
  v_level_count int;
begin
  if p_student_id is null or p_run_id is null then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  if auth.uid() is not null and auth.uid() is distinct from p_student_id then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if p_visibility not in ('none', 'nickname', 'anonymous', 'name') then
    raise exception 'invalid_request: visibility' using errcode = 'P0001';
  end if;

  select * into v_run from public.competitive_runs where id = p_run_id;
  if not found or v_run.student_id is distinct from p_student_id then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_run.status = 'in_progress' then
    raise exception 'conflict: run in progress' using errcode = 'P0001';
  end if;

  select coalesce((settings->>'levelCount')::int, 6) into v_level_count
  from public.competitive_topics where code = v_run.topic_code;

  if v_run.level_number <> v_level_count then
    raise exception 'invalid_request: only Super level is ranked' using errcode = 'P0001';
  end if;

  -- name only meaningful for class scope; still store visibility as requested
  update public.competitive_runs
  set visibility = p_visibility
  where id = p_run_id;

  return jsonb_build_object('published', p_visibility is distinct from 'none');
end;
$$;

create or replace function public.api_get_leaderboard(
  p_caller_id uuid,
  p_topic_code text,
  p_scope text,
  p_limit int,
  p_class_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_limit int;
  v_rows jsonb := '[]'::jsonb;
  v_grade int;
  v_class uuid;
  v_school uuid;
  r record;
  v_rank int := 0;
  v_name text;
  v_year_start date;
begin
  if p_caller_id is null or p_topic_code is null or p_scope is null then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  if p_scope not in ('class', 'school', 'school_year', 'absolute') then
    raise exception 'invalid_request: scope' using errcode = 'P0001';
  end if;
  v_limit := least(50, greatest(1, coalesce(p_limit, 10)));

  -- resolve caller's class/school/grade when student
  select m.class_id, c.school_id into v_class, v_school
  from public.class_students m
  join public.classes c on c.id = m.class_id
  where m.student_id = p_caller_id
  limit 1;

  if v_class is null and p_class_id is not null then
    -- teacher path
    if not exists (
      select 1 from public.class_teachers ct
      where ct.class_id = p_class_id and ct.teacher_id = p_caller_id
    ) then
      raise exception 'not_found' using errcode = 'P0001';
    end if;
    v_class := p_class_id;
    select school_id into v_school from public.classes where id = v_class;
  end if;

  if v_class is null and p_scope in ('class', 'school', 'school_year') then
    raise exception 'invalid_request: class required' using errcode = 'P0001';
  end if;

  v_grade := (
    select cs.grade_level from public.class_subjects cs
    where cs.class_id = v_class order by cs.grade_level limit 1
  );

  -- school year: 1 Sep – 31 Aug
  if extract(month from now()) >= 9 then
    v_year_start := make_date(extract(year from now())::int, 9, 1);
  else
    v_year_start := make_date(extract(year from now())::int - 1, 9, 1);
  end if;

  for r in
    with bests as (
      select distinct on (b.student_id)
        b.student_id,
        b.best_score as score,
        b.best_duration_ms as duration_ms,
        b.best_at as achieved_at,
        p.full_name,
        p.generated_nickname,
        (
          select cr.visibility
          from public.competitive_runs cr
          where cr.student_id = b.student_id
            and cr.topic_code = b.topic_code
            and cr.status <> 'in_progress'
            and cr.visibility <> 'none'
          order by cr.score desc, cr.duration_ms asc nulls last
          limit 1
        ) as visibility
      from public.competitive_best b
      join public.profiles p on p.id = b.student_id
      join public.class_students m on m.student_id = b.student_id
      join public.classes c on c.id = m.class_id
      left join public.class_subjects cs on cs.class_id = c.id
      where b.topic_code = p_topic_code
        and b.best_score > 0
        and (
          (p_scope = 'class' and m.class_id = v_class)
          or (p_scope = 'school' and c.school_id = v_school and cs.grade_level = v_grade)
          or (p_scope = 'school_year' and c.school_id = v_school and cs.grade_level = v_grade
              and b.best_at >= v_year_start)
          or (p_scope = 'absolute' and cs.grade_level = v_grade)
        )
      order by b.student_id, b.best_score desc, b.best_duration_ms asc
    )
    select * from bests
    where visibility is not null and visibility <> 'none'
    order by score desc, duration_ms asc, achieved_at asc
    limit v_limit
  loop
    v_rank := v_rank + 1;
    v_name := case r.visibility
      when 'name' then case when p_scope = 'class' then r.full_name else coalesce(r.generated_nickname, 'Учень') end
      when 'nickname' then coalesce(nullif(r.generated_nickname, ''), 'Учень')
      else 'Учень'
    end;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'rank', v_rank,
      'displayName', v_name,
      'score', r.score,
      'durationMs', r.duration_ms,
      'achievedAt', r.achieved_at
    ));
  end loop;

  return jsonb_build_object('rows', v_rows);
end;
$$;

create or replace function public.api_get_competitive_results(
  p_teacher_id uuid,
  p_class_id uuid,
  p_topic_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_rows jsonb := '[]'::jsonb;
  r record;
begin
  if p_teacher_id is null or p_class_id is null then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  if auth.uid() is not null and auth.uid() is distinct from p_teacher_id then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.class_teachers
    where class_id = p_class_id and teacher_id = p_teacher_id
  ) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  for r in
    select
      p.id as student_id,
      p.full_name,
      coalesce(b.attempt_count, 0) as attempt_count,
      coalesce(b.best_score, 0) as best_score,
      coalesce(b.best_duration_ms, 0) as best_duration_ms,
      (
        select cr.finished_at
        from public.competitive_runs cr
        where cr.student_id = p.id
          and (p_topic_code is null or cr.topic_code = p_topic_code)
          and cr.finished_at is not null
        order by cr.finished_at desc
        limit 1
      ) as last_run_at,
      (
        select cr.duration_ms
        from public.competitive_runs cr
        where cr.student_id = p.id
          and (p_topic_code is null or cr.topic_code = p_topic_code)
          and cr.finished_at is not null
        order by cr.finished_at desc
        limit 1
      ) as last_run_duration_ms
    from public.class_students m
    join public.profiles p on p.id = m.student_id
    left join public.competitive_best b
      on b.student_id = p.id
     and (p_topic_code is null or b.topic_code = p_topic_code)
    where m.class_id = p_class_id
    order by p.full_name
  loop
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'studentId', r.student_id,
      'fullName', r.full_name,
      'attemptCount', r.attempt_count,
      'bestScore', r.best_score,
      'bestDurationMs', r.best_duration_ms,
      'lastRunAt', r.last_run_at,
      'lastRunDurationMs', r.last_run_duration_ms
    ));
  end loop;

  return jsonb_build_object('rows', v_rows);
end;
$$;

-- Grants: service_role only for write path; list/leaderboard also authenticated with uid checks
revoke all on function public.api_list_competitive_topics(uuid) from public, anon;
revoke all on function public.api_start_competitive_run(uuid, text, int) from public, anon;
revoke all on function public.api_submit_competitive_answer(uuid, uuid, uuid, jsonb) from public, anon;
revoke all on function public.api_publish_competitive_result(uuid, uuid, text) from public, anon;
revoke all on function public.api_get_leaderboard(uuid, text, text, int, uuid) from public, anon;
revoke all on function public.api_get_competitive_results(uuid, uuid, text) from public, anon;

grant execute on function public.api_list_competitive_topics(uuid) to service_role;
grant execute on function public.api_start_competitive_run(uuid, text, int) to service_role;
grant execute on function public.api_submit_competitive_answer(uuid, uuid, uuid, jsonb) to service_role;
grant execute on function public.api_publish_competitive_result(uuid, uuid, text) to service_role;
grant execute on function public.api_get_leaderboard(uuid, text, text, int, uuid) to service_role;
grant execute on function public.api_get_competitive_results(uuid, uuid, text) to service_role;

-- Private helpers not callable by clients
revoke all on function private.competitive_student_grade(uuid) from public, anon, authenticated;
revoke all on function private.competitive_limit_ms(jsonb, integer) from public, anon, authenticated;
revoke all on function private.competitive_issue_question(uuid, text, integer, jsonb) from public, anon, authenticated;
revoke all on function private.competitive_finish_run(uuid, text) from public, anon, authenticated;
grant execute on function private.competitive_student_grade(uuid) to service_role;
grant execute on function private.competitive_limit_ms(jsonb, integer) to service_role;
grant execute on function private.competitive_issue_question(uuid, text, integer, jsonb) to service_role;
grant execute on function private.competitive_finish_run(uuid, text) to service_role;

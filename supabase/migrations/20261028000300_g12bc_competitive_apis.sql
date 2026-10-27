-- G12b/c: competitive run lifecycle + leaderboards (review fixes).
-- Do NOT apply to production from agents; owner applies after review.
-- No temporary tables; no DELETE without WHERE.

-- Track answers / anti-repeat on run state
alter table private.competitive_run_state
  add column if not exists answered_count integer not null default 0,
  add column if not exists prev_prompt_text text,
  add column if not exists prev2_prompt_text text;

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

create or replace function private.competitive_student_class(p_student_id uuid)
returns table (class_id uuid, school_id uuid, grade_level integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.class_id, c.school_id, cs.grade_level
  from public.class_students m
  join public.classes c on c.id = m.class_id
  left join lateral (
    select grade_level from public.class_subjects s
    where s.class_id = m.class_id
    order by s.grade_level
    limit 1
  ) cs on true
  where m.student_id = p_student_id
  limit 1;
$$;

create or replace function private.competitive_limit_ms(
  p_settings jsonb,
  p_score integer,
  p_level_number integer,
  p_level_count integer
)
returns integer
language plpgsql
immutable
as $$
declare
  v_fl jsonb;
  v_sec int;
begin
  -- Finite levels: fixed secondsPerQuestion
  if p_level_number is not null
     and p_level_count is not null
     and p_level_number < p_level_count then
    select elem into v_fl
    from jsonb_array_elements(coalesce(p_settings->'finiteLevels', '[]'::jsonb)) elem
    where (elem->>'levelNumber')::int = p_level_number
    limit 1;
    if v_fl is not null then
      v_sec := coalesce((v_fl->>'secondsPerQuestion')::int, 8);
      return greatest(1000, v_sec * 1000);
    end if;
  end if;
  -- Super curve
  return greatest(
    coalesce((p_settings->>'minLimitMs')::int, 3500),
    coalesce((p_settings->>'startLimitMs')::int, 8000)
      - (greatest(p_score, 0) / greatest(coalesce((p_settings->>'stepEvery')::int, 5), 1))
        * coalesce((p_settings->>'stepMs')::int, 300)
  );
end;
$$;

create or replace function private.competitive_issue_question(
  p_run_id uuid,
  p_topic_code text,
  p_score integer,
  p_settings jsonb,
  p_level_number integer,
  p_level_count integer
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
  v_prev text;
  v_prev2 text;
  v_try int := 0;
begin
  select prev_prompt_text, prev2_prompt_text
    into v_prev, v_prev2
  from private.competitive_run_state
  where run_id = p_run_id;

  -- Difficulty: finite level N → N; Super → curve by position
  if p_level_number < p_level_count then
    v_diff := greatest(1, least(5, p_level_number));
  else
    v_pos := greatest(p_score, 0) + 1;
    v_curve := coalesce(p_settings->'difficultyCurve', '[]'::jsonb);
    if jsonb_typeof(v_curve) = 'array' and jsonb_array_length(v_curve) >= v_pos then
      v_diff := greatest(1, least(5, coalesce((v_curve->>(v_pos - 1))::int, 1)));
    elsif v_pos > 78 then
      v_diff := 5;
    end if;
  end if;

  loop
    v_try := v_try + 1;
    if p_topic_code = 'multiplication_table' and p_score >= 60 and p_level_number = p_level_count then
      v_b := least(10, greatest(1, v_diff + floor(random() * 3)::int));
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
    exit when v_try >= 12
      or (v_prompt is distinct from v_prev and v_prompt is distinct from v_prev2);
  end loop;

  v_limit := private.competitive_limit_ms(p_settings, p_score, p_level_number, p_level_count);

  insert into private.competitive_run_state (
    run_id, question_id, prompt_text, answer_key, issued_at, limit_ms,
    answered_count, prev_prompt_text, prev2_prompt_text, updated_at
  ) values (
    p_run_id, v_qid, v_prompt,
    jsonb_build_object('type', 'numeric', 'value', v_key),
    now(), v_limit,
    0, null, null, now()
  )
  on conflict (run_id) do update set
    question_id = excluded.question_id,
    prompt_text = excluded.prompt_text,
    answer_key = excluded.answer_key,
    issued_at = excluded.issued_at,
    limit_ms = excluded.limit_ms,
    prev2_prompt_text = private.competitive_run_state.prev_prompt_text,
    prev_prompt_text = excluded.prompt_text,
    updated_at = now();

  return jsonb_build_object(
    'id', v_qid,
    'promptText', v_prompt,
    'type', 'numeric',
    'limitMs', v_limit
  );
end;
$$;

-- Rank among published Super runs for one scope (1-based). Uses only published runs.
create or replace function private.competitive_rank_in_scope(
  p_student_id uuid,
  p_topic_code text,
  p_score integer,
  p_duration_ms integer,
  p_scope text
)
returns integer
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_class uuid;
  v_school uuid;
  v_grade int;
  v_year_start date;
  v_better int;
begin
  select class_id, school_id, grade_level
    into v_class, v_school, v_grade
  from private.competitive_student_class(p_student_id);

  if extract(month from now()) >= 9 then
    v_year_start := make_date(extract(year from now())::int, 9, 1);
  else
    v_year_start := make_date(extract(year from now())::int - 1, 9, 1);
  end if;

  with published as (
    select distinct on (cr.student_id)
      cr.student_id, cr.score, cr.duration_ms, cr.finished_at
    from public.competitive_runs cr
    join public.class_students m on m.student_id = cr.student_id
    join public.classes c on c.id = m.class_id
    left join lateral (
      select grade_level from public.class_subjects s
      where s.class_id = c.id order by s.grade_level limit 1
    ) cs on true
    join public.competitive_topics t on t.code = cr.topic_code
    where cr.topic_code = p_topic_code
      and cr.visibility <> 'none'
      and cr.status <> 'in_progress'
      and cr.level_number = coalesce((t.settings->>'levelCount')::int, 6)
      and (
        (p_scope = 'class' and m.class_id = v_class)
        or (p_scope = 'school' and c.school_id = v_school and cs.grade_level = v_grade)
        or (p_scope = 'school_year' and c.school_id = v_school and cs.grade_level = v_grade
            and cr.finished_at >= v_year_start)
        or (p_scope = 'absolute' and cs.grade_level = v_grade)
      )
    order by cr.student_id, cr.score desc, cr.duration_ms asc nulls last, cr.finished_at asc
  )
  select count(*)::int into v_better
  from published p
  where p.student_id is distinct from p_student_id
    and (
      p.score > p_score
      or (p.score = p_score and coalesce(p.duration_ms, 0) < coalesce(p_duration_ms, 0))
    );

  return coalesce(v_better, 0) + 1;
end;
$$;

create or replace function private.competitive_finish_run(
  p_run_id uuid,
  p_status text,
  p_passed boolean default null
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
  v_lb_size int;
  v_scope text;
  v_rank int;
  v_state private.competitive_run_state%rowtype;
begin
  select * into v_run from public.competitive_runs where id = p_run_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_run.status <> 'in_progress' then
    return jsonb_build_object(
      'runId', v_run.id,
      'score', v_run.score,
      'durationMs', coalesce(v_run.duration_ms, 0),
      'isPersonalBest', false,
      'qualified', '[]'::jsonb
    );
  end if;

  select * into v_state from private.competitive_run_state where run_id = p_run_id;
  -- duration: prefer issued_at of last question on timeout path (caller may pass completed after timeout)
  v_dur := greatest(0, (extract(epoch from (now() - v_run.started_at)) * 1000)::int);

  update public.competitive_runs
  set status = p_status,
      finished_at = now(),
      duration_ms = v_dur
  where id = p_run_id;

  select settings into v_settings from public.competitive_topics where code = v_run.topic_code;
  v_level_count := coalesce((v_settings->>'levelCount')::int, 6);
  v_lb_size := coalesce((v_settings->>'leaderboardSize')::int, 10);

  if v_run.level_number = v_level_count then
    -- Super: update personal best by score/duration
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

    -- qualified ranks vs published peers (hypothetical if this run were published)
    foreach v_scope in array array['class', 'school', 'school_year', 'absolute']
    loop
      v_rank := private.competitive_rank_in_scope(
        v_run.student_id, v_run.topic_code, v_run.score, v_dur, v_scope
      );
      if v_rank is not null and v_rank <= v_lb_size then
        v_qualified := v_qualified || jsonb_build_array(jsonb_build_object(
          'scope', v_scope,
          'rank', v_rank
        ));
      end if;
    end loop;
  else
    -- Finite: bump attempt_count; unlock only if p_passed
    insert into public.competitive_best (
      student_id, topic_code, best_score, best_duration_ms, best_at, attempt_count, max_level_passed
    ) values (
      v_run.student_id, v_run.topic_code, 0, 0, now(), 1, 0
    )
    on conflict (student_id, topic_code) do update
      set attempt_count = public.competitive_best.attempt_count + 1;

    if coalesce(p_passed, false) then
      update public.competitive_best
      set max_level_passed = greatest(max_level_passed, v_run.level_number)
      where student_id = v_run.student_id and topic_code = v_run.topic_code;
    end if;
  end if;

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
        when v_best.student_id is null or coalesce(v_best.best_score, 0) = 0 then null
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
    and started_at >= date_trunc('day', now() at time zone 'utc');
  if v_daily >= v_daily_limit then
    raise exception 'conflict: daily run limit' using errcode = 'P0001';
  end if;

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

  v_q := private.competitive_issue_question(
    v_run_id, p_topic_code, 0, v_settings, p_level_number, v_level_count
  );

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
  v_pass_pct numeric;
  v_fl jsonb;
  v_answered int;
  v_is_super boolean;
  v_passed boolean;
begin
  if p_student_id is null or p_run_id is null or p_question_id is null then
    raise exception 'invalid_request' using errcode = 'P0001';
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
  v_level_count := coalesce((v_settings->>'levelCount')::int, 6);
  v_is_super := (v_run.level_number = v_level_count);

  if v_elapsed_ms < v_min_answer then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  -- timeout
  if v_elapsed_ms > coalesce(v_state.limit_ms, 8000) + v_grace then
    if v_is_super then
      v_result := private.competitive_finish_run(p_run_id, 'completed', false);
      return jsonb_build_object('finished', true, 'result', v_result);
    end if;
    -- finite: count as answered wrong and continue or finish by count
    v_correct := false;
  else
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
  end if;

  -- Super: first wrong ends
  if v_is_super and not v_correct then
    v_result := private.competitive_finish_run(p_run_id, 'completed', false);
    return jsonb_build_object('finished', true, 'result', v_result);
  end if;

  if v_correct then
    update public.competitive_runs set score = score + 1 where id = p_run_id;
    v_run.score := v_run.score + 1;
  end if;

  update private.competitive_run_state
  set answered_count = answered_count + 1
  where run_id = p_run_id
  returning answered_count into v_answered;

  if not v_is_super then
    select elem into v_fl
    from jsonb_array_elements(coalesce(v_settings->'finiteLevels', '[]'::jsonb)) elem
    where (elem->>'levelNumber')::int = v_run.level_number
    limit 1;
    v_finite_count := coalesce((v_fl->>'questionCount')::int, 10);
    v_pass_pct := coalesce((v_fl->>'passPercent')::numeric, 80);

    if v_answered >= v_finite_count then
      v_passed := (v_run.score::numeric / v_finite_count * 100.0) >= v_pass_pct;
      v_result := private.competitive_finish_run(p_run_id, 'completed', v_passed);
      return jsonb_build_object('finished', true, 'result', v_result);
    end if;

    -- continue finite after wrong or correct
    v_q := private.competitive_issue_question(
      p_run_id, v_run.topic_code, v_run.score, v_settings,
      v_run.level_number, v_level_count
    );
    return jsonb_build_object(
      'finished', false,
      'correct', v_correct,
      'score', v_run.score,
      'question', jsonb_build_object(
        'id', v_q->>'id',
        'promptText', v_q->>'promptText',
        'type', 'numeric'
      ),
      'limitMs', (v_q->>'limitMs')::int
    );
  end if;

  -- Super correct → next question
  v_q := private.competitive_issue_question(
    p_run_id, v_run.topic_code, v_run.score, v_settings,
    v_run.level_number, v_level_count
  );
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
  v_level_count int;
begin
  if p_caller_id is null or p_topic_code is null or p_scope is null then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  if p_scope not in ('class', 'school', 'school_year', 'absolute') then
    raise exception 'invalid_request: scope' using errcode = 'P0001';
  end if;
  v_limit := least(50, greatest(1, coalesce(p_limit, 10)));

  select coalesce((settings->>'levelCount')::int, 6) into v_level_count
  from public.competitive_topics where code = p_topic_code;
  if v_level_count is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  select m.class_id, c.school_id into v_class, v_school
  from public.class_students m
  join public.classes c on c.id = m.class_id
  where m.student_id = p_caller_id
  limit 1;

  if v_class is null and p_class_id is not null then
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

  if extract(month from now()) >= 9 then
    v_year_start := make_date(extract(year from now())::int, 9, 1);
  else
    v_year_start := make_date(extract(year from now())::int - 1, 9, 1);
  end if;

  -- ONLY published Super runs; best per student among those
  for r in
    with published as (
      select distinct on (cr.student_id)
        cr.student_id,
        cr.score,
        cr.duration_ms,
        cr.finished_at as achieved_at,
        cr.visibility,
        p.full_name,
        p.generated_nickname
      from public.competitive_runs cr
      join public.profiles p on p.id = cr.student_id
      join public.class_students m on m.student_id = cr.student_id
      join public.classes c on c.id = m.class_id
      left join lateral (
        select grade_level from public.class_subjects s
        where s.class_id = c.id order by s.grade_level limit 1
      ) cs on true
      where cr.topic_code = p_topic_code
        and cr.visibility <> 'none'
        and cr.status <> 'in_progress'
        and cr.level_number = v_level_count
        and (
          (p_scope = 'class' and m.class_id = v_class)
          or (p_scope = 'school' and c.school_id = v_school and cs.grade_level = v_grade)
          or (p_scope = 'school_year' and c.school_id = v_school and cs.grade_level = v_grade
              and cr.finished_at >= v_year_start)
          or (p_scope = 'absolute' and cs.grade_level = v_grade)
        )
      order by cr.student_id, cr.score desc, cr.duration_ms asc nulls last, cr.finished_at asc
    )
    select * from published
    order by score desc, duration_ms asc nulls last, achieved_at asc
    limit v_limit
  loop
    v_rank := v_rank + 1;
    v_name := case r.visibility
      when 'name' then case when p_scope = 'class' then r.full_name else coalesce(nullif(r.generated_nickname, ''), 'Учень') end
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
      coalesce((
        select b.attempt_count from public.competitive_best b
        where b.student_id = p.id
          and (p_topic_code is null or b.topic_code = p_topic_code)
        order by b.attempt_count desc nulls last
        limit 1
      ), 0) as attempt_count,
      coalesce((
        select b.best_score from public.competitive_best b
        where b.student_id = p.id
          and (p_topic_code is null or b.topic_code = p_topic_code)
        order by b.best_score desc nulls last
        limit 1
      ), 0) as best_score,
      coalesce((
        select b.best_duration_ms from public.competitive_best b
        where b.student_id = p.id
          and (p_topic_code is null or b.topic_code = p_topic_code)
        order by b.best_score desc nulls last
        limit 1
      ), 0) as best_duration_ms,
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

-- Grants: service_role ONLY
revoke all on function public.api_list_competitive_topics(uuid) from public, anon, authenticated;
revoke all on function public.api_start_competitive_run(uuid, text, int) from public, anon, authenticated;
revoke all on function public.api_submit_competitive_answer(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.api_publish_competitive_result(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.api_get_leaderboard(uuid, text, text, int, uuid) from public, anon, authenticated;
revoke all on function public.api_get_competitive_results(uuid, uuid, text) from public, anon, authenticated;

grant execute on function public.api_list_competitive_topics(uuid) to service_role;
grant execute on function public.api_start_competitive_run(uuid, text, int) to service_role;
grant execute on function public.api_submit_competitive_answer(uuid, uuid, uuid, jsonb) to service_role;
grant execute on function public.api_publish_competitive_result(uuid, uuid, text) to service_role;
grant execute on function public.api_get_leaderboard(uuid, text, text, int, uuid) to service_role;
grant execute on function public.api_get_competitive_results(uuid, uuid, text) to service_role;

revoke all on function private.competitive_student_grade(uuid) from public, anon, authenticated;
revoke all on function private.competitive_student_class(uuid) from public, anon, authenticated;
revoke all on function private.competitive_limit_ms(jsonb, integer, integer, integer) from public, anon, authenticated;
revoke all on function private.competitive_issue_question(uuid, text, integer, jsonb, integer, integer) from public, anon, authenticated;
revoke all on function private.competitive_rank_in_scope(uuid, text, integer, integer, text) from public, anon, authenticated;
revoke all on function private.competitive_finish_run(uuid, text, boolean) from public, anon, authenticated;

grant execute on function private.competitive_student_grade(uuid) to service_role;
grant execute on function private.competitive_student_class(uuid) to service_role;
grant execute on function private.competitive_limit_ms(jsonb, integer, integer, integer) to service_role;
grant execute on function private.competitive_issue_question(uuid, text, integer, jsonb, integer, integer) to service_role;
grant execute on function private.competitive_rank_in_scope(uuid, text, integer, integer, text) to service_role;
grant execute on function private.competitive_finish_run(uuid, text, boolean) to service_role;

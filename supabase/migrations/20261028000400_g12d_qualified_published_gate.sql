-- G12d polish: qualified[] only when this Super run is not worse than the
-- student's already-published best Super run (coordinator non-blocker on #104).
-- Do NOT apply to production from agents.

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
  v_pub_score int;
  v_pub_dur int;
  v_offer_publish boolean := true;
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

    -- Best already-published Super run for this student (exclude current, still visibility=none)
    select cr.score, cr.duration_ms
      into v_pub_score, v_pub_dur
    from public.competitive_runs cr
    where cr.student_id = v_run.student_id
      and cr.topic_code = v_run.topic_code
      and cr.level_number = v_level_count
      and cr.status <> 'in_progress'
      and cr.visibility <> 'none'
      and cr.id is distinct from p_run_id
    order by cr.score desc, cr.duration_ms asc nulls last
    limit 1;

    if found then
      -- Offer publish/qualified only if this run is not worse than published best
      v_offer_publish := (
        v_run.score > v_pub_score
        or (v_run.score = v_pub_score and v_dur <= coalesce(v_pub_dur, v_dur))
      );
    end if;

    if v_offer_publish then
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
    end if;
  else
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

revoke all on function private.competitive_finish_run(uuid, text, boolean) from public, anon, authenticated;
grant execute on function private.competitive_finish_run(uuid, text, boolean) to service_role;

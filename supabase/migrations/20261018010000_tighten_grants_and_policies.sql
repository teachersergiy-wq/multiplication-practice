-- NOT APPLIED to any database. Review first; apply on a Supabase branch, run the checks
-- from the pull request, and only then promote.
--
-- Fixes found by comparing the repository with the live catalog (read-only queries):
--  1. Live grants include DELETE/INSERT/UPDATE/TRUNCATE/TRIGGER/REFERENCES for anon and
--     authenticated on every public table (platform default privileges). The earlier
--     migration only revoked INSERT/UPDATE/DELETE on attempts and responses.
--     RLS still denies anon, but TRUNCATE ignores RLS, so the grants are removed.
--  2. multiplication_configs_manage_teacher let any teacher change the shared level
--     configuration used by every class. Configs become read-only for clients.
--  3. Students could not read custom subjects of assigned tests (subjects_read_active).
--  4. A template could be inserted directly as 'published' without ever being a draft.

-- 1. Remove blanket table grants, then restore exactly what the first migration intended.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

grant select on public.schools, public.classes, public.profiles, public.class_teachers, public.class_students,
  public.subjects, public.class_subjects, public.assessment_templates, public.assessment_questions,
  public.assessment_assignments, public.assessment_attempts, public.assessment_responses,
  public.multiplication_level_configs to authenticated;
grant insert, update, delete on public.subjects, public.class_subjects, public.assessment_templates,
  public.assessment_questions, public.assessment_assignments to authenticated;

-- Helper functions stay callable by signed-in users and the service role, not by anon/PUBLIC.
revoke execute on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated, service_role;

-- 2. Shared multiplication level configs are managed by migrations or a future server function.
drop policy if exists multiplication_configs_manage_teacher on public.multiplication_level_configs;

-- 3. A subject is visible if it is a system subject, the user's own, or used by a class the user belongs to.
drop policy subjects_read_active on public.subjects;
create policy subjects_read_active on public.subjects for select to authenticated using (
  active and (
    is_system
    or created_by = (select auth.uid())
    or exists (
      select 1 from public.class_subjects cs
      where cs.subject_id = subjects.id
        and (private.can_manage_class(cs.class_id) or private.is_class_student(cs.class_id))
    )
  )
);

-- 4. New templates always start as drafts. Publishing is a separate step.
drop policy templates_create_owner on public.assessment_templates;
create policy templates_create_owner on public.assessment_templates for insert to authenticated with check (
  teacher_id = (select auth.uid())
  and status = 'draft'
  and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'teacher')
);

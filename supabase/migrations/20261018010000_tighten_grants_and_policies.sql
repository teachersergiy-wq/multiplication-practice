-- NOT APPLIED to any database. Review first; apply on a local Supabase or a
-- paid Supabase branch only with owner approval, run tests/checks, then promote.
-- Never apply blindly to production project bvetbqbxjrvrmdhszmcw from CI/agents.
--
-- Fixes found by comparing the repository with the live catalog (read-only):
--  1. Live grants include DELETE/INSERT/UPDATE/TRUNCATE/TRIGGER/REFERENCES for anon and
--     authenticated on every public table (platform default privileges). The earlier
--     migration only revoked INSERT/UPDATE/DELETE on attempts and responses.
--     RLS still denies anon, but TRUNCATE ignores RLS, so excess grants are removed.
--  2. multiplication_configs_manage_teacher let any teacher change the shared level
--     configuration used by every class. Configs become read-only for browser roles.
--  3. Students could not read custom subjects of assigned tests (subjects_read_active).
--  4. A template could be inserted directly as 'published' without ever being a draft.
--
-- Scope: only grants + the four policy fixes above. No data model changes.

-- ---------------------------------------------------------------------------
-- 1. Remove blanket table grants, then restore exactly what clients need.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- Default privileges must target the role that creates objects in migrations.
-- Unscoped ALTER DEFAULT PRIVILEGES only affects objects created by the current user.
-- Only `postgres` is referenced: `supabase_admin` is not guaranteed in every local stack.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;

-- Defense in depth: answer keys stay unreachable even if a future grant slips in.
revoke all on table private.assessment_answer_keys from public, anon, authenticated;

grant select on
  public.schools,
  public.classes,
  public.profiles,
  public.class_teachers,
  public.class_students,
  public.subjects,
  public.class_subjects,
  public.assessment_templates,
  public.assessment_questions,
  public.assessment_assignments,
  public.assessment_attempts,
  public.assessment_responses,
  public.multiplication_level_configs
to authenticated;

-- Write path for teacher-managed catalog objects only. Attempts/responses stay
-- server-side (Edge Functions with service_role).
grant insert, update, delete on
  public.subjects,
  public.class_subjects,
  public.assessment_templates,
  public.assessment_questions,
  public.assessment_assignments
to authenticated;

-- Helper functions stay callable by signed-in users and service_role, not anon.
revoke execute on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Shared multiplication level configs: migrations / future server only.
-- ---------------------------------------------------------------------------
drop policy if exists multiplication_configs_manage_teacher on public.multiplication_level_configs;
-- SELECT policy multiplication_configs_read remains.

-- ---------------------------------------------------------------------------
-- 3. Subject visibility for system, owner, class membership, or assigned test.
-- ---------------------------------------------------------------------------
-- Acceptance: a student must read a teacher-created subject used by a test
-- assigned to their class. class_subjects covers the catalog link; the
-- assignment path covers the case where the subject is only reachable via an
-- active assignment.
drop policy if exists subjects_read_active on public.subjects;
create policy subjects_read_active on public.subjects
for select
to authenticated
using (
  active
  and (
    is_system
    or created_by = (select auth.uid())
    or exists (
      select 1
      from public.class_subjects cs
      where cs.subject_id = subjects.id
        and (
          private.can_manage_class(cs.class_id)
          or private.is_class_student(cs.class_id)
        )
    )
    or exists (
      select 1
      from public.assessment_assignments a
      join public.assessment_templates t on t.id = a.template_id
      where t.subject_id = subjects.id
        and t.status = 'published'
        and (
          private.can_manage_class(a.class_id)
          or private.is_class_student(a.class_id)
        )
    )
  )
);

-- ---------------------------------------------------------------------------
-- 4. New templates always start as drafts. Publishing is a separate UPDATE.
-- ---------------------------------------------------------------------------
-- templates_update_draft_owner (freeze migration) allows updating a draft row;
-- its WITH CHECK does not force status='draft', so draft -> published works.
drop policy if exists templates_create_owner on public.assessment_templates;
create policy templates_create_owner on public.assessment_templates
for insert
to authenticated
with check (
  teacher_id = (select auth.uid())
  and status = 'draft'
  and exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'teacher'
  )
);

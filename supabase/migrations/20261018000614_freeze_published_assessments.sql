-- A published test is immutable; future edits should create a new version.
drop policy templates_update_owner on public.assessment_templates;
create policy templates_update_draft_owner on public.assessment_templates for update to authenticated
using (teacher_id = (select auth.uid()) and status = 'draft')
with check (teacher_id = (select auth.uid()));

-- Questions remain editable only while the owning template is a draft.
drop policy questions_update_owner_draft on public.assessment_questions;
create policy questions_update_owner_draft on public.assessment_questions for update to authenticated
using (private.owns_template(template_id) and exists (
  select 1 from public.assessment_templates t where t.id = template_id and t.status = 'draft'
))
with check (private.owns_template(template_id) and exists (
  select 1 from public.assessment_templates t where t.id = template_id and t.status = 'draft'
));

-- Assignment edits must preserve both class access and subject/grade compatibility.
drop policy assignments_update_teacher on public.assessment_assignments;
create policy assignments_update_teacher on public.assessment_assignments for update to authenticated
using (private.can_manage_class(class_id) and assigned_by = (select auth.uid()))
with check (
  private.can_manage_class(class_id) and assigned_by = (select auth.uid()) and exists (
    select 1 from public.assessment_templates t join public.class_subjects cs
      on cs.class_id = assessment_assignments.class_id and cs.subject_id = t.subject_id and cs.grade_level = t.grade_level
    where t.id = assessment_assignments.template_id and t.teacher_id = auth.uid() and t.status = 'published'
  )
);

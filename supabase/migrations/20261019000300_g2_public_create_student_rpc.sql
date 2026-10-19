-- G2: public.create_student_records wrapper, service_role only.

create or replace function public.create_student_records(
  p_student_id uuid,
  p_full_name text,
  p_login_code text,
  p_class_id uuid,
  p_nickname text
)
returns void
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  perform private.create_student_records(
    p_student_id, p_full_name, p_login_code, p_class_id, p_nickname
  );
end;
$$;

revoke all on function public.create_student_records(uuid, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.create_student_records(uuid, text, text, uuid, text)
  to service_role;

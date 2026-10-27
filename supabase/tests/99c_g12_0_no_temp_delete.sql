-- G12-0: api_* must not use temporary tables or DELETE without WHERE (pg_safeupdate).
-- CI does not enable pg_safeupdate; this test blocks regressions via pg_get_functiondef.
begin;

do $$
declare
  r record;
  def text;
  def_norm text;
  bad text[] := '{}';
  targets text[] := array[
    'public.api_generate_multiplication_test',
    'public.api_generate_multiplication_bank',
    'private.sample_pool_questions'
  ];
  t text;
  found boolean;
begin
  foreach t in array targets loop
    found := false;
    for r in
      select p.oid, pg_get_functiondef(p.oid) as def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname || '.' || p.proname = t
    loop
      found := true;
      def := r.def;
      def_norm := lower(def);

      -- Temporary tables (CREATE TEMP / TEMPORARY TABLE)
      if def_norm ~ 'create\s+(temporary|temp)\s+table' then
        bad := array_append(bad, t || ': create temporary table');
      end if;

      -- DELETE without WHERE (simple forms; allow DELETE ... WHERE)
      -- Matches "delete from x;" / "delete from x" at end of statement without where.
      if def_norm ~ 'delete\s+from\s+[a-z0-9_."]+\s*;' then
        bad := array_append(bad, t || ': delete from ... without where');
      elsif def_norm ~ 'delete\s+from\s+[a-z0-9_."]+\s*$' then
        bad := array_append(bad, t || ': delete from ... without where (eol)');
      end if;
    end loop;

    if not found then
      perform tests.fail(format('function %s not found', t));
    end if;
  end loop;

  if coalesce(array_length(bad, 1), 0) > 0 then
    perform tests.fail('pg_safeupdate risk: ' || array_to_string(bad, '; '));
  end if;

  perform tests.ok(true, 'G12-0: no temp table / unqualified DELETE in guarded functions');
end;
$$;

select tests.ok(true, '99c_g12_0_no_temp_delete completed');
rollback;

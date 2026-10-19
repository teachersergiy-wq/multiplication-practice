-- G2b: create_student_records EXECUTE matrix; provision name length.
begin;

select tests.ok(
  not has_function_privilege(
    'anon',
    'public.create_student_records(uuid,text,text,uuid,text)',
    'execute'
  ),
  'anon cannot EXECUTE public.create_student_records'
);

select tests.ok(
  not has_function_privilege(
    'authenticated',
    'public.create_student_records(uuid,text,text,uuid,text)',
    'execute'
  ),
  'authenticated cannot EXECUTE public.create_student_records'
);

select tests.ok(
  has_function_privilege(
    'service_role',
    'public.create_student_records(uuid,text,text,uuid,text)',
    'execute'
  ),
  'service_role can EXECUTE public.create_student_records'
);

-- Short fullName rejected
select tests.throws(
  $q$
    select public.api_provision_teacher(
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa75'::uuid,
      'X',
      'School',
      'Class'
    )
  $q$,
  'api_provision_teacher rejects fullName shorter than 2'
);

-- Empty after trim rejected
select tests.throws(
  $q$
    select public.api_provision_teacher(
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa75'::uuid,
      '  ',
      'School',
      'Class'
    )
  $q$,
  'api_provision_teacher rejects blank fullName'
);

select tests.ok(true, '75_g2b_privileges_and_names completed');
rollback;

-- G11: BIG pool tests (require full migration logic).
begin;
select tests.ok(true, '99_g11_big_pool placeholder until logic migration lands');
rollback;

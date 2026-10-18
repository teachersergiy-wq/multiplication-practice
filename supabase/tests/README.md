# Security SQL tests (G0)

These tests validate grants and RLS after `20261018010000_tighten_grants_and_policies.sql`.

## Requirements

- Local Supabase (Docker) or any Postgres with the project migrations applied.
- Extensions used by seed paths: `pgcrypto` (for `crypt`/`gen_salt` in test fixtures).
- **Do not run against production** `bvetbqbxjrvrmdhszmcw`.

## Run

```bash
# from repo root, with local stack up
supabase db reset   # applies migrations locally
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/00_helpers.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/10_grants_and_anon.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/20_policies_subjects_templates.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/30_teacher_isolation.sql
```

Each file runs in a transaction and **rolls back** fixture data.

## Status in Grok cloud session

`docker`, `psql`, and `supabase` CLI were **not available**. Runtime execution is **BLOCKED** in that environment; tests are provided for the owner/local runner.

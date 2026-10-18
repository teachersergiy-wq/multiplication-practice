# Security SQL tests (G0)

These tests validate grants and RLS after `20261018010000_tighten_grants_and_policies.sql`.

## Requirements

- `supabase/config.toml` present (CI gate).
- Local Supabase (Docker) or CI job `Database tests`.
- Extensions used by fixtures: `pgcrypto` (via `crypt`/`gen_salt`).
- **Do not run against production** `bvetbqbxjrvrmdhszmcw`.

## Run (local)

```bash
supabase start
export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
for f in supabase/tests/[0-9][0-9]_*.sql; do
  echo "== $f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

Each numbered file after `00_helpers.sql` runs in a transaction and rolls back fixtures.

## What the helpers mean

| Helper | Use when |
|--------|----------|
| `tests.throws` | Statement must raise (missing GRANT, WITH CHECK fail) |
| `tests.updates_zero_rows` | UPDATE/DELETE succeeds but RLS affects 0 rows |
| `tests.ok` | Boolean assertion |

## Verify after apply (owner, non-prod)

See `VERIFY_AFTER_APPLY.sql`.

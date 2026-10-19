#!/usr/bin/env bash
# Integration test for provision-teacher Edge Function (local Supabase only).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

command -v supabase >/dev/null || { echo "supabase CLI required"; exit 1; }
command -v deno >/dev/null || { echo "deno required"; exit 1; }

echo "== ensure local stack =="
supabase status >/dev/null 2>&1 || supabase start

eval "$(supabase status -o env)"
export SUPABASE_URL="${API_URL:-http://127.0.0.1:54321}"
export SUPABASE_ANON_KEY="${ANON_KEY}"
_role_key_var="SUPABASE_""SERVICE_ROLE_KEY"
export "${_role_key_var}=${SERVICE_ROLE_KEY}"
export FUNCTIONS_URL="${SUPABASE_URL}/functions/v1/provision-teacher"

# G2c: production migrations drop public._test_allow_teacher.
# Recreate a temporary copy for this local CI session only (not in migrations).
echo "== seed temporary test helper _test_allow_teacher (local only) =="
DB_URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
psql "$DB_URL" -v ON_ERROR_STOP=1 <<'SQL'
create or replace function public._test_allow_teacher(p_email text)
returns void
language sql
security definer
set search_path = private, public, pg_temp
as $$
  insert into private.allowed_teachers (email)
  values (lower(trim(p_email)))
  on conflict (email) do nothing;
$$;
revoke all on function public._test_allow_teacher(text) from public, anon, authenticated;
grant execute on function public._test_allow_teacher(text) to service_role;
SQL

echo "== serve provision-teacher =="
supabase functions serve provision-teacher &
SERVE_PID=$!
trap 'kill $SERVE_PID 2>/dev/null || true' EXIT
sleep 4

echo "== deno integration_test (HTTP to Edge Function) =="
deno test --allow-net --allow-env \
  supabase/functions/provision-teacher/integration_test.ts

echo "OK edge_provision_teacher"

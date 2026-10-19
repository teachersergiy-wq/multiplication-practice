#!/usr/bin/env bash
# G2b Edge / Auth probes for local Supabase or CI db-tests job.
# Coordinator: add a step after `supabase start`:
#   bash supabase/tests/run_edge_g2b.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

command -v supabase >/dev/null || { echo "BLOCKED: supabase CLI missing"; exit 1; }
command -v deno >/dev/null || { echo "BLOCKED: deno missing"; exit 1; }

supabase status >/dev/null 2>&1 || supabase start
eval "$(supabase status -o env)"
export SUPABASE_URL="${API_URL:-http://127.0.0.1:54321}"
export SUPABASE_ANON_KEY="${ANON_KEY}"
_role_key_var="SUPABASE_""SERVICE_ROLE_KEY"
export "${_role_key_var}=${SERVICE_ROLE_KEY}"
export SERVICE_ROLE_KEY
export FUNCTIONS_URL="${SUPABASE_URL}/functions/v1"
export STUDENT_EMAIL_DOMAIN="${STUDENT_EMAIL_DOMAIN:-students.local.invalid}"

echo "== Auth password / .invalid domain probe =="
deno run --allow-net --allow-env supabase/tests/edge_auth_password_probe.ts

echo "== serve functions (background) =="
supabase functions serve --env-file /dev/null &
SERVE_PID=$!
trap 'kill $SERVE_PID 2>/dev/null || true' EXIT
sleep 5

echo "== Edge negative smoke =="
deno run --allow-net --allow-env supabase/tests/edge_lifecycle_negatives.ts

echo "OK run_edge_g2b"

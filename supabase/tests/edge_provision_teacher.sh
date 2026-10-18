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
export SUPABASE_SERVICE_ROLE_KEY="${SERVICE_ROLE_KEY}"
export FUNCTIONS_URL="${SUPABASE_URL}/functions/v1/provision-teacher"

echo "== serve provision-teacher =="
supabase functions serve provision-teacher &
SERVE_PID=$!
trap 'kill $SERVE_PID 2>/dev/null || true' EXIT
sleep 4

echo "== deno integration_test (HTTP to Edge Function) =="
deno test --allow-net --allow-env \
  supabase/functions/provision-teacher/integration_test.ts

echo "OK edge_provision_teacher"

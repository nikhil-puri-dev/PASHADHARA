#!/usr/bin/env bash
# Create a clean database on the throwaway Postgres (container pashadhara-rails-15434, host port 15434).
# Usage: scripts/live-db.sh live_run1   -> postgres://kernel_login@127.0.0.1:15434/live_run1
# Never run against a supabase_* container. Drops the named database if it exists.
set -euo pipefail
export MSYS_NO_PATHCONV=1
name="${1:?database name}"
[[ "$name" =~ ^live_[a-z0-9_]+$ ]] || { echo "name must match live_[a-z0-9_]+" >&2; exit 1; }
box=pashadhara-rails-15434
here="$(cd "$(dirname "$0")/../../.." && (pwd -W 2>/dev/null || pwd))"
docker cp "$here/packages/contract/schema.sql" "$box:/tmp/schema.sql"
docker cp "$here/packages/contract/roles.sql" "$box:/tmp/roles.sql"
docker exec "$box" psql -U postgres -q -c "drop database if exists $name" -c "create database $name"
docker exec "$box" psql -U postgres -d "$name" -v ON_ERROR_STOP=1 -q -f /tmp/schema.sql
docker exec "$box" psql -U postgres -d "$name" -v ON_ERROR_STOP=1 -q -f /tmp/roles.sql 2>/dev/null
docker cp "$here/apps/api/sql/tool_results.sql" "$box:/tmp/tool_results.sql"
docker exec "$box" psql -U postgres -d "$name" -v ON_ERROR_STOP=1 -q -f /tmp/tool_results.sql
echo "postgres://kernel_login@127.0.0.1:15434/$name"

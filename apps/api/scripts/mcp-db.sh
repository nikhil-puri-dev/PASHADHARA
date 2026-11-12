#!/usr/bin/env bash
# Fresh database on the throwaway Postgres container pashadhara-mcp-15433 (host port 15433). Never a supabase_* container.
# Usage: scripts/mcp-db.sh mcp_run1
set -euo pipefail
export MSYS_NO_PATHCONV=1
name="${1:?database name}"
[[ "$name" =~ ^(mcp|live)_[a-z0-9_]+$ ]] || { echo "name must match (mcp|live)_[a-z0-9_]+" >&2; exit 1; }
box=pashadhara-mcp-15433
here="$(cd "$(dirname "$0")/../../.." && (pwd -W 2>/dev/null || pwd))"
docker cp "$here/packages/contract/schema.sql" "$box:/tmp/schema.sql"
docker cp "$here/packages/contract/roles.sql" "$box:/tmp/roles.sql"
docker cp "$here/apps/api/sql/tool_results.sql" "$box:/tmp/tool_results.sql"
docker cp "$here/apps/api/sql/showcase.sql" "$box:/tmp/showcase.sql"
docker exec "$box" psql -U postgres -q -c "drop database if exists $name" -c "create database $name"
docker exec "$box" psql -U postgres -d "$name" -v ON_ERROR_STOP=1 -q -f /tmp/schema.sql
docker exec "$box" psql -U postgres -d "$name" -v ON_ERROR_STOP=1 -q -f /tmp/roles.sql 2>/dev/null || true
docker exec "$box" psql -U postgres -d "$name" -v ON_ERROR_STOP=1 -q -f /tmp/tool_results.sql
docker exec "$box" psql -U postgres -d "$name" -v ON_ERROR_STOP=1 -q -f /tmp/showcase.sql
echo "$name"

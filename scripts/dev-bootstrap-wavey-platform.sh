#!/usr/bin/env bash
# Bootstrap a Platform OAuth Client in Cal.diy for the Wavey project to consume.
#
# Cal.diy strips the Cal.com Platform admin UI but the backend (PlatformOAuthClient
# table + /v2/oauth-clients API + managed-user flow) is intact. The UI at
# /settings/developer/oauth-clients creates the wrong type (OAuthClient SSO).
# This script creates the right type directly so Wavey can drive Cal via API v2.
#
# Idempotent: re-running with the same CLIENT_NAME returns the existing row's
# credentials without rotating the secret.
#
# Usage:
#   scripts/dev-bootstrap-wavey-platform.sh
#   CLIENT_NAME=wavey-staging REDIRECT_URIS="http://localhost:3000,http://localhost:8080" ./scripts/dev-bootstrap-wavey-platform.sh
#
# Requires the calcom-postgres Docker container to be running (see local dev setup).

set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-calcom-postgres}"
PG_USER="${PG_USER:-calcom}"
PG_DB="${PG_DB:-calendso}"

CLIENT_NAME="${CLIENT_NAME:-wavey-local}"
REDIRECT_URIS="${REDIRECT_URIS:-http://localhost:3000}"

# Acme Inc is seeded with isAdminReviewed=true and isAdminAPIEnabled=true,
# so its OAuth clients work out of the box. Override ORG_ID to use a different
# org (must already exist and be admin-approved).
ORG_ID="${ORG_ID:-4}"

# 1023 = all 10 permission bits (EVENT_TYPE_R/W, BOOKING_R/W, SCHEDULE_R/W,
# APPS_R/W, PROFILE_R/W) per packages/platform/constants/permissions.ts.
PERMISSIONS_BITMASK="${PERMISSIONS_BITMASK:-1023}"

psql_query() {
  docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 "$@"
}

# Verify Postgres is reachable and the target org is admin-approved.
if ! docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" >/dev/null 2>&1; then
  echo "ERROR: container '$PG_CONTAINER' is not accepting connections." >&2
  exit 1
fi

ORG_STATUS=$(psql_query -t -A -c \
  "SELECT t.name || '|' || os.\"isAdminReviewed\" || '|' || os.\"isAdminAPIEnabled\"
   FROM \"Team\" t LEFT JOIN \"OrganizationSettings\" os ON os.\"organizationId\" = t.id
   WHERE t.id = $ORG_ID AND t.\"isOrganization\" = true;" | tr -d '[:space:]')

if [[ -z "$ORG_STATUS" ]]; then
  echo "ERROR: Organization id $ORG_ID does not exist or isn't an organization." >&2
  exit 1
fi

ORG_NAME="${ORG_STATUS%%|*}"
ORG_REVIEWED="$(echo "$ORG_STATUS" | cut -d'|' -f2)"
ORG_API_ENABLED="$(echo "$ORG_STATUS" | cut -d'|' -f3)"

if [[ "$ORG_REVIEWED" != "true" ]] || [[ "$ORG_API_ENABLED" != "true" ]]; then
  echo "Org '$ORG_NAME' is not fully approved (isAdminReviewed=$ORG_REVIEWED, isAdminAPIEnabled=$ORG_API_ENABLED) — auto-approving."
  psql_query -q -c \
    "UPDATE \"OrganizationSettings\"
     SET \"isAdminReviewed\" = true, \"isAdminAPIEnabled\" = true
     WHERE \"organizationId\" = $ORG_ID;" >/dev/null
fi

# Escape single quotes in the client name for SQL safety.
NAME_ESC="${CLIENT_NAME//\'/\'\'}"

EXISTING=$(psql_query -t -A -F'|' -c \
  "SELECT id, secret FROM \"PlatformOAuthClient\" WHERE name = '$NAME_ESC' LIMIT 1;")

if [[ -n "$EXISTING" ]]; then
  CLIENT_ID="${EXISTING%%|*}"
  CLIENT_SECRET="${EXISTING#*|}"
  STATE="reusing existing"
else
  # cuid-like: 'c' + 24 hex chars (subset of cuid's [a-z0-9] charset).
  # Using openssl avoids a SIGPIPE / exit 141 from `tr | head` under `set -e`.
  CLIENT_ID="c$(openssl rand -hex 12)"
  # 64-char URL-safe random secret.
  CLIENT_SECRET="$(openssl rand -base64 48 | tr -d '\n=' | tr '+/' '-_')"

  # Build PostgreSQL text[] array literal from comma-separated URIs.
  REDIRECT_LITERAL='{'
  IFS=',' read -ra URIS <<< "$REDIRECT_URIS"
  for i in "${!URIS[@]}"; do
    URI="${URIS[$i]//\"/\\\"}"
    [[ $i -gt 0 ]] && REDIRECT_LITERAL+=','
    REDIRECT_LITERAL+="\"$URI\""
  done
  REDIRECT_LITERAL+='}'

  psql_query -q -c \
    "INSERT INTO \"PlatformOAuthClient\"
     (id, name, secret, permissions, \"redirectUris\", \"organizationId\",
      \"areEmailsEnabled\", \"areDefaultEventTypesEnabled\", \"areCalendarEventsEnabled\")
     VALUES
     ('$CLIENT_ID', '$NAME_ESC', '$CLIENT_SECRET', $PERMISSIONS_BITMASK,
      '$REDIRECT_LITERAL'::text[], $ORG_ID, false, true, true);" >/dev/null
  STATE="created new"
fi

cat <<EOF

================================================================================
Platform OAuth Client: $STATE
  name:         $CLIENT_NAME
  organization: $ORG_NAME (id $ORG_ID)
  redirectUris: $REDIRECT_URIS
  permissions:  $PERMISSIONS_BITMASK (all)

Wavey environment variables (copy into Wavey's .env):

  CALCOM_API_URL=http://localhost:5555/v2
  CALCOM_OAUTH_CLIENT_ID=$CLIENT_ID
  CALCOM_OAUTH_CLIENT_SECRET=$CLIENT_SECRET

Smoke test (should return 200 OK and an empty users list initially):
  curl -s -H "x-cal-secret-key: $CLIENT_SECRET" \\
       http://localhost:5555/v2/oauth-clients/$CLIENT_ID/users
================================================================================
EOF

#!/bin/sh
set -eu

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${POSTGRES_TEAM_HOST_PASSWORD:?POSTGRES_TEAM_HOST_PASSWORD is required}"
: "${POSTGRES_TEAM_BROKER_PASSWORD:?POSTGRES_TEAM_BROKER_PASSWORD is required}"

validate_hex_secret() {
  case "$1" in
    ''|*[!0-9a-f]*)
      echo "runtime database passwords must be non-empty lowercase hexadecimal values" >&2
      exit 1
      ;;
  esac
}

validate_hex_secret "$POSTGRES_PASSWORD"
validate_hex_secret "$POSTGRES_TEAM_HOST_PASSWORD"
validate_hex_secret "$POSTGRES_TEAM_BROKER_PASSWORD"

if [ "$POSTGRES_PASSWORD" = "$POSTGRES_TEAM_HOST_PASSWORD" ] \
  || [ "$POSTGRES_PASSWORD" = "$POSTGRES_TEAM_BROKER_PASSWORD" ] \
  || [ "$POSTGRES_TEAM_HOST_PASSWORD" = "$POSTGRES_TEAM_BROKER_PASSWORD" ]; then
  echo "migration, Team Host, and Credential Broker database passwords must differ" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOSQL
CREATE ROLE dsh_team_host NOLOGIN;
CREATE ROLE dsh_team_broker NOLOGIN;
CREATE ROLE dsh_team_host_login LOGIN PASSWORD '$POSTGRES_TEAM_HOST_PASSWORD';
CREATE ROLE dsh_team_broker_login LOGIN PASSWORD '$POSTGRES_TEAM_BROKER_PASSWORD';
GRANT dsh_team_host TO dsh_team_host_login;
GRANT dsh_team_broker TO dsh_team_broker_login;
EOSQL

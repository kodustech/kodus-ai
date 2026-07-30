#!/usr/bin/env bash
set -euo pipefail

ENV_FILE=".env"
SCOPE="full" # backend|web|full

usage() {
  cat <<'USAGE'
Usage: scripts/dev/env-doctor.sh [--env-file <path>] [--scope backend|web|full]

Checks required .env variables for local development in the monorepo.
Exit code:
  0 -> all required vars are set
  1 -> one or more required vars are missing/empty
  2 -> invalid usage or env file not found
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      ENV_FILE="${2:-}"
      shift 2
      ;;
    --scope)
      SCOPE="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[env-doctor] unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ "$SCOPE" != "backend" && "$SCOPE" != "web" && "$SCOPE" != "full" ]]; then
  echo "[env-doctor] invalid --scope '$SCOPE' (use backend|web|full)" >&2
  exit 2
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[env-doctor] env file not found: $ENV_FILE" >&2
  exit 2
fi

get_env_value() {
  local key="$1"
  local line

  line=$(awk -v k="$key" 'index($0, k"=") == 1 { print $0 }' "$ENV_FILE" | tail -n 1 || true)
  if [[ -z "$line" ]]; then
    echo "__MISSING__"
    return
  fi

  local value="${line#*=}"
  value="$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"

  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi

  echo "$value"
}

is_empty_or_placeholder() {
  local value="$1"
  case "$value" in
    ""|"your_api_key_here"|"changeme"|"CHANGE_ME"|"null"|"NULL")
      return 0
      ;;
  esac

  if [[ "$value" == "<"*">" ]]; then
    return 0
  fi

  return 1
}

required_backend=(
  "API_PORT:Backend HTTP port"
  "API_PG_DB_HOST:Postgres host"
  "API_PG_DB_PORT:Postgres port"
  "API_PG_DB_USERNAME:Postgres user"
  "API_PG_DB_PASSWORD:Postgres password"
  "API_PG_DB_DATABASE:Postgres database"
  "API_MG_DB_HOST:Mongo host"
  "API_MG_DB_PORT:Mongo port"
  "API_MG_DB_USERNAME:Mongo user"
  "API_MG_DB_PASSWORD:Mongo password"
  "API_MG_DB_DATABASE:Mongo database"
  "API_RABBITMQ_URI:RabbitMQ URI"
  "API_JWT_SECRET:JWT signing secret"
  "API_JWT_REFRESH_SECRET:JWT refresh secret"
  "API_CRYPTO_KEY:Encryption key"
  "CODE_MANAGEMENT_SECRET:Code management secret"
  "CODE_MANAGEMENT_WEBHOOK_TOKEN:Code management webhook token"
)

required_web=(
  "WEB_PORT:Web HTTP port"
  "WEB_HOSTNAME_API:Backend hostname consumed by web"
  "WEB_NEXTAUTH_SECRET:Auth.js secret"
  "NEXTAUTH_URL:Auth.js base URL"
)

optional_web_oauth=(
  "WEB_OAUTH_GITHUB_CLIENT_ID:GitHub OAuth client id"
  "WEB_OAUTH_GITHUB_CLIENT_SECRET:GitHub OAuth client secret"
  "WEB_OAUTH_GITLAB_CLIENT_ID:GitLab OAuth client id"
  "WEB_OAUTH_GITLAB_CLIENT_SECRET:GitLab OAuth client secret"
)

errors=()
warnings=()
checked_required=0

check_required_list() {
  local item key desc value

  for item in "$@"; do
    key="${item%%:*}"
    desc="${item#*:}"
    value="$(get_env_value "$key")"
    checked_required=$((checked_required + 1))

    if [[ "$value" == "__MISSING__" ]] || is_empty_or_placeholder "$value"; then
      errors+=("$key ($desc)")
    fi
  done
}

check_optional_list() {
  local item key desc value

  for item in "$@"; do
    key="${item%%:*}"
    desc="${item#*:}"
    value="$(get_env_value "$key")"

    if [[ "$value" == "__MISSING__" ]] || is_empty_or_placeholder "$value"; then
      warnings+=("$key not set ($desc) - required only if you use this integration")
    fi
  done
}

if [[ "$SCOPE" == "backend" || "$SCOPE" == "full" ]]; then
  check_required_list "${required_backend[@]}"
fi

if [[ "$SCOPE" == "web" || "$SCOPE" == "full" ]]; then
  check_required_list "${required_web[@]}"
  check_optional_list "${optional_web_oauth[@]}"
fi

# Cross-checks (warnings only)
api_port="$(get_env_value API_PORT)"
web_port_api="$(get_env_value WEB_PORT_API)"
nextauth_url="$(get_env_value NEXTAUTH_URL)"

if [[ "$api_port" != "__MISSING__" && "$web_port_api" != "__MISSING__" && "$api_port" != "$web_port_api" ]]; then
  warnings+=("WEB_PORT_API ($web_port_api) differs from API_PORT ($api_port)")
fi

if [[ "$nextauth_url" != "__MISSING__" && "$nextauth_url" != http://* && "$nextauth_url" != https://* ]]; then
  warnings+=("NEXTAUTH_URL should start with http:// or https://")
fi

echo "[env-doctor] file=$ENV_FILE scope=$SCOPE"
echo "[env-doctor] required checks=$checked_required"

if [[ ${#warnings[@]} -gt 0 ]]; then
  echo "[env-doctor] warnings (${#warnings[@]}):"
  for w in "${warnings[@]}"; do
    echo "  - $w"
  done
fi

if [[ ${#errors[@]} -gt 0 ]]; then
  echo "[env-doctor] missing required vars (${#errors[@]}):"
  for e in "${errors[@]}"; do
    echo "  - $e"
  done
  echo "[env-doctor] fix tip: run 'pnpm run setup' and re-check"
  exit 1
fi

echo "[env-doctor] ok: required variables are set"
exit 0

#!/usr/bin/env bash
set -euo pipefail

if [ $# -gt 0 ]; then
  ENVIRONMENT=$1
  shift
else
  ENVIRONMENT=local
fi

COMPOSE_FILE="docker-compose.dev.yml"
COMPOSE_FILES=(-f "$COMPOSE_FILE")
# `docker compose` only auto-loads `docker-compose.override.yml` when the
# main file is the default `docker-compose.yml`. Since we pass `-f` here,
# we have to opt in explicitly. Useful in worktrees that need to coexist
# with the main checkout (renamed containers, remapped ports, isolated
# volumes/networks).
if [ -f "docker-compose.override.yml" ]; then
  COMPOSE_FILES+=(-f "docker-compose.override.yml")
  echo "▶ Detected docker-compose.override.yml — including it."
fi
PROFILE_ARGS=()

case "$ENVIRONMENT" in
  local)
    export ENV_FILE=${ENV_FILE:-.env}
    export API_DATABASE_ENV=${API_DATABASE_ENV:-development}
    # profiling=opt-in. Most dev flows don't need Pyroscope running and
    # it's another ~150 MiB of headroom in the OrbStack VM. To bring it
    # up: `ENABLE_PROFILING=true pnpm run docker:start`, or use the
    # `pnpm run docker:start:profiling` shortcut, or `pnpm run docker:start:full`
    # (which activates the `extras` profile that includes Pyroscope).
    PROFILE_ARGS=()
    if [ "${ENABLE_PROFILING:-false}" = "true" ]; then
      PROFILE_ARGS+=(--profile profiling)
    fi
    # Opt-in extras: webhooks, mcp, analytics, or `extras` (all three).
    # Default `pnpm run docker:start` brings up api + worker + web only; pass
    # KODUS_DEV_EXTRAS=mcp (or comma-separated list, or `extras`) to add.
    # Empty/unset = none added.
    if [ -n "${KODUS_DEV_EXTRAS:-}" ]; then
      IFS=',' read -ra _EXTRA_PROFILES <<< "$KODUS_DEV_EXTRAS"
      for _p in "${_EXTRA_PROFILES[@]}"; do
        _p_trimmed=$(echo "$_p" | tr -d '[:space:]')
        if [ -n "$_p_trimmed" ]; then
          PROFILE_ARGS+=(--profile "$_p_trimmed")
        fi
      done
    fi
    ENV_LABEL="local"
    ;;
  qa|homolog)
    export ENV_FILE=${ENV_FILE:-.env}
    export API_DATABASE_ENV=${API_DATABASE_ENV:-homolog}
    ENV_LABEL="homolog"
    ;;
  prod|production)
    export ENV_FILE=${ENV_FILE:-.env}
    export API_DATABASE_ENV=${API_DATABASE_ENV:-production}
    ENV_LABEL="production"
    ;;
  *)
    echo "Uso: $0 [local|qa|prod] [comandos docker compose]" >&2
    exit 1
    ;;

esac

if [ ! -f "$ENV_FILE" ]; then
  echo "Arquivo de ambiente '$ENV_FILE' não encontrado. Ajuste suas variáveis no .env ou informe ENV_FILE com o caminho desejado." >&2
  exit 1
fi

if [ $# -eq 0 ]; then
  set -- up
fi

echo "Iniciando docker compose ($ENV_LABEL) com arquivo $ENV_FILE ..."

if [ ${#PROFILE_ARGS[@]} -gt 0 ]; then
  docker compose "${COMPOSE_FILES[@]}" "${PROFILE_ARGS[@]}" "$@"
else
  docker compose "${COMPOSE_FILES[@]}" "$@"
fi

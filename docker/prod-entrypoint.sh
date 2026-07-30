#!/bin/sh
set -e # Exit immediately if a command exits with a non-zero status

echo "▶ Starting deployment entrypoint..."

# ----------------------------------------------------------------
# Auto-tune Node.js Memory based on Container Limits
# ----------------------------------------------------------------
# If max-old-space-size is not explicitly set in NODE_OPTIONS,
# calculate it as 85% of the container's memory limit.
# ----------------------------------------------------------------
if ! echo "$NODE_OPTIONS" | grep -q "max-old-space-size"; then
    # Detect memory limit from Cgroups (v1 or v2)
    if [ -f /sys/fs/cgroup/memory.max ]; then
        MEM_BYTES=$(cat /sys/fs/cgroup/memory.max)
    elif [ -f /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
        MEM_BYTES=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes)
    fi

    # Check if limit is a valid number (not 'max' or extremely large)
    if [ "$MEM_BYTES" != "" ] && [ "$MEM_BYTES" != "max" ] && [ "$MEM_BYTES" -lt 9223372036854771712 ] 2>/dev/null; then
        MEM_MB=$((MEM_BYTES / 1024 / 1024))
        # Set heap to 85% of total RAM
        CALCULATED_HEAP=$((MEM_MB * 85 / 100))
        export NODE_OPTIONS="$NODE_OPTIONS --max-old-space-size=$CALCULATED_HEAP"
        echo "  - Memory Auto-tune: Detected ${MEM_MB}MB. Setting --max-old-space-size=${CALCULATED_HEAP}"
    else
        echo "  - Memory Auto-tune: No container limit detected. Using Node.js defaults."
    fi
fi

# ----------------------------------------------------------------
# Dynamic Environment Configuration
# ----------------------------------------------------------------
# In production images, environment values are compiled into dist at build time.
# We only log effective runtime flags here and avoid mutating ./dist, which may
# be non-writable in ECS (non-root user/read-only filesystem).
# ----------------------------------------------------------------

CLOUD_MODE=${API_CLOUD_MODE:-false}
DEV_MODE=${API_DEVELOPMENT_MODE:-false}

echo "▶ Configuring Environment..."
echo "  - API_CLOUD_MODE: $CLOUD_MODE"
echo "  - API_DEVELOPMENT_MODE: $DEV_MODE"

# ----------------------------------------------------------------
# Standard Startup
# ----------------------------------------------------------------

RUN_MIGRATIONS="${RUN_MIGRATIONS:-false}"
RUN_SEEDS="${RUN_SEEDS:-false}"

if [ "$RUN_MIGRATIONS" = "true" ]; then
  echo "▶ Running OLTP migrations (PROD)..."
  # Use node with compiled migrations in prod
  if [ -f "dist/libs/core/infrastructure/database/typeorm/ormconfig.js" ]; then
      npm run migration:run:prod
  else
      echo "⚠️ Migration config not found at dist/libs/core/infrastructure/database/typeorm/ormconfig.js. Skipping."
  fi

  echo "▶ Ensuring analytics schema exists (PROD)..."
  # See dev-entrypoint.sh for rationale. Idempotent.
  if [ -f "dist/scripts/analytics/ensure-schema.cli.js" ]; then
      npm run analytics:ensure-schema:prod
  else
      echo "⚠️ ensure-schema CLI not found in dist/. Skipping (migration may fail on first boot)."
  fi

  echo "▶ Running analytics warehouse migrations (PROD)..."
  if [ -f "dist/libs/ee/analytics-warehouse/infrastructure/ormconfig.js" ]; then
      npm run analytics:migration:run:prod
  else
      echo "⚠️ Analytics ormconfig not found at dist/libs/ee/analytics-warehouse/infrastructure/ormconfig.js. Skipping."
  fi

  # MCP manager owns its own schema and runs its migration from a
  # dedicated entrypoint. The API container does NOT touch it.
else
  echo "▶ Skipping migrations (RUN_MIGRATIONS=$RUN_MIGRATIONS)"
fi

if [ "$RUN_SEEDS" = "true" ]; then
  echo "▶ Running Seeds (PROD)..."
  # Seeds might also need a prod version if they rely on TS
  npm run seed:prod
else
  echo "▶ Skipping seeds (RUN_SEEDS=$RUN_SEEDS)"
fi

echo "▶ Starting Application..."
# exec "$@" executes the CMD defined in the Dockerfile (pm2-runtime ...)
exec "$@"

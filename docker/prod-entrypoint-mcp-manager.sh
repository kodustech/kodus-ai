#!/bin/sh
set -e # Exit immediately if a command exits with a non-zero status

echo "▶ Starting mcp-manager deployment entrypoint..."

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
# Migrations (this container only — always)
# ----------------------------------------------------------------
# mcp-manager owns its own schema and always runs ensure-schema +
# migration on boot. Migrations are idempotent (TypeORM tracks
# applied ones in a metadata table and uses an advisory lock so
# simultaneous boots don't race), so running them every start is
# safe and removes the need for orchestration to remember to set
# RUN_MIGRATIONS=true on this task.
#
# Previously the API entrypoint ran every migration in the repo,
# including this one. That broke API boot when the mcp-manager DB
# context was missing or different — see fix(mcp-manager): isolate
# migration ownership from API entrypoint.
# ----------------------------------------------------------------

CLOUD_MODE=${API_CLOUD_MODE:-false}
DEV_MODE=${API_DEVELOPMENT_MODE:-false}

echo "▶ Configuring Environment..."
echo "  - API_CLOUD_MODE: $CLOUD_MODE"
echo "  - API_DEVELOPMENT_MODE: $DEV_MODE"

echo "▶ Ensuring mcp-manager schema exists (PROD)..."
if [ -f "dist/scripts/mcp-manager/ensure-schema.cli.js" ]; then
    npm run mcp-manager:ensure-schema:prod
else
    echo "⚠️ mcp-manager ensure-schema CLI not found in dist/. Skipping (migration may fail on first boot)."
fi

echo "▶ Running mcp-manager migrations (PROD)..."
if [ -f "dist/apps/mcp-manager/src/config/typeorm.config.js" ]; then
    npm run mcp-manager:migration:run:prod
else
    echo "⚠️ mcp-manager typeorm.config not found at dist/apps/mcp-manager/src/config/typeorm.config.js. Skipping."
fi

echo "▶ Starting mcp-manager..."
# exec "$@" executes the CMD defined in the Dockerfile.
exec "$@"

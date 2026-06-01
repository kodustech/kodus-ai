# Source provenance

This app was originally a separate repo: `github.com/kodustech/kodus-mcp-manager`.

Imported into kodus-ai as a monorepo merge:

- **Imported from commit**: `fb4c5d9` of `kodustech/kodus-mcp-manager`
  ("Merge pull request #66 from kodustech/fix/composio-url")
- **Imported on**: 2026-05-04
- **Image name preserved**: `ghcr.io/kodustech/kodus-mcp-manager:<tag>`
  — no change required in `kodus-installer/docker-compose.yml`.

## Modifications applied during the import

1. **Imports rewritten** — code in the original repo used absolute
   imports rooted at the package's `baseUrl` (`from 'src/...'`). The
   monorepo's webpack config uses the kodus-ai root tsconfig and does
   not honor a per-app `baseUrl`. All `from 'src/...'` imports were
   rewritten to relative paths (`from '../../...'`).

2. **`tsconfig.json` rewired** — extends `../../tsconfig.json`
   (kodus-ai root). Output goes to `dist/apps/mcp-manager/`. `@libs/*`
   path mapping added so this app can import from `kodus-ai/libs/`
   (currently unused, available for future shared code).

3. **`package.json` slimmed** — deps moved to the root `package.json`
   (kodus-ai monorepo pattern). The local `package.json` only carries
   the app `name`, `scripts`, and stub `dependencies: {}`.

4. **Config path resolution** — `IntegrationDescriptionService` and
   `KodusMcpProvider` originally used `process.cwd() + 'src/config/...'`.
   In the monorepo, `cwd` is the kodus-ai root (`/usr/src/app`), not
   `apps/mcp-manager/`. Both were changed to use `__dirname`-relative
   paths.

## Migrations

Database migrations live in `apps/mcp-manager/src/database/migrations/`
and run automatically on container boot when `RUN_MIGRATIONS=true`
(see `docker/dev-entrypoint.sh` and `docker/prod-entrypoint.sh`). They
target a separate Postgres schema named `mcp-manager` (configurable
via `API_MCP_MANAGER_PG_DB_SCHEMA`). Use `yarn mcp-manager:migration:*`
scripts for local migration management.

## What was NOT brought over

- The original repo's `docker-compose.yml` / `docker-compose.prod.yml`
  — the kodus-ai root `docker-compose.dev.yml` already wires this app
  up, and prod is composed by `kodus-installer`.
- `ecosystem.config.js` (PM2) — kodus-ai uses Docker, not PM2.
- The original `.github/workflows/` — replaced by kodus-ai's unified
  `selfhosted-build-push.yml` which now builds and publishes the
  `kodus-mcp-manager` image alongside the others.
- `postman/`, `self-hosted/` directories — operationally equivalent
  output now lives in kodus-installer / docs site.

## Updating from upstream

The original repo is now archived. There is no upstream to track. To
make changes, edit `apps/mcp-manager/` directly in kodus-ai.

If for some reason you need to import another future change from a
fork:

```bash
# 1. Copy source over
cp -r /path/to/source-repo/src/* apps/mcp-manager/src/

# 2. Re-apply the import rewrite
python3 scripts/mcp-manager/rewrite-imports.py    # (if you keep one)

# 3. Re-apply the __dirname config-path fix in
#    apps/mcp-manager/src/modules/providers/services/integration-description.service.ts

# 4. Validate
yarn install && yarn build mcp-manager
```

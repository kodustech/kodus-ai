---
name: perf-debug
description: End-to-end front→back performance debugging for the Kodus web app. Use when a screen is slow, blank, looping, or you need to trace a UI perf problem down to the API query. Drives Playwright/Chrome MCP to open + measure the screen, then reads the API use-case/repository and the DB (Postgres/Mongo indexes, explain) to find and fix the root cause, verifying live.
---

# Perf debug (front → back)

Repeatable loop for resolving Kodus web performance problems, from the rendered
screen down to the DB query. Built from real sessions on the token-usage,
pull-requests, settings and cockpit screens.

## The loop

1. **Open the screen** — Playwright (`mcp__plugin_playwright_playwright__*`) or
   Chrome MCP. App is auth-gated; `/` is 404 post-Next16, log in at `/sign-in`
   (email → Continue → password). Test user: `Novus@teste.com` (org
   `aae1c003-…` has real data). Reset its password via Postgres if needed
   (bcryptjs hash; see the memory).

2. **Observe — never trust the first load.** Capture `browser_console_messages`
   (errors) + `browser_network_requests` (fan-out). **Reload 2× on a settled
   dev server**: HMR produces phantom hydration errors / truncated-parse 500s.
   Only what reproduces on a clean load is real.

3. **Measure** via the Performance API (`browser_evaluate`):
   `nav.responseStart` (TTFB), FCP, LCP, load. Classify the bottleneck:
   - high TTFB → **SSR-data-bound** (server component awaiting slow data)
   - big JS / slow FCP after TTFB → **bundle-bound**
   - janky interaction → **render-bound** (note: React Compiler is ON, so
     manual memo is rarely the fix).

4. **Understand the components** — read the page.tsx / client component. Find the
   server/client split and the loading states. Watch for `if (!isMounted) return
   null` (blanks the body pre-hydration → show a skeleton instead) and effects
   that `router.replace` with `searchParams` in deps (reload loops).

5. **Trace to the API** — from the fan-out, pick the heavy/redundant endpoints
   (duplicates, per-page `/api/auth/session`, `/executions`, cockpit fan-out).

6. **Understand the query** — read `apps/api/src/controllers/*` →
   `libs/**/use-cases` → repository. Then hit the DB directly:
   - Postgres: `docker exec kodus_api printenv API_PG_DB_PASSWORD`, then
     `docker exec -e PGPASSWORD=… db_postgres psql -U kodusdev -d kodus_db`.
     Check `pg_indexes` for the table; look for OFFSET-in-loop, uncached
     `COUNT(*)`, N+1 (`relations:[...]` on a to-one is a JOIN, not N+1).
   - Mongo: `docker exec mongodb mongosh "mongodb://kodusdev:<pass>@localhost:27017/<db>?authSource=admin"`.
     `db.<coll>.getIndexes()` (watch for **partial indexes** matching the
     filter), `.explain("executionStats")` — compare `totalKeysExamined` vs
     `nReturned`. See the `mongodb-query-optimizer` skill for deeper analysis.
   - Kodus DB is generally **well-indexed**; the real backend wins are usually
     algorithmic (keyset vs OFFSET) or caching — and only reproduce at prod
     scale (dev DB is tiny), so prepare the patch and validate in staging.

7. **Fix surgically + verify live** — one change, then re-measure + re-check
   console on a clean reload. Confirm no new hydration errors, no 500.

8. **Isolate when unsure — revert to compare.** If a change might be the cause,
   `git checkout -- <file>` (back it up first) and reload: if the symptom
   persists with the original, your change is exonerated. (Used to prove the
   token-usage blank was a pre-existing reload loop, not the recharts port.)

## Dev-env gotchas (these cost hours if unknown)

- **HMR noise** → hydration/parse errors that vanish on a 2nd clean reload.
- **Turbopack truncated-parse cache** (`Unexpected eof` on a valid file) →
  `touch` the file to force a fresh re-read. Root cause: `CHOKIDAR_USEPOLLING=false`
  + `:delegated` bind-mount catches partial writes.
- **OOM** → heavy routes (charts + turbopack) blow the web container's memory
  limit. Check `docker stats` / `docker inspect --format '{{.State.OOMKilled}}'`;
  bump `deploy.resources.limits.memory` (web needed 4G, 2G OOM'd).
- **Reload loop** → a page hammering its own document (`GET /x` ×1000s, CPU
  pegged, blank body). Diagnose via request count in `docker logs`. Cause is
  usually an effect that navigates with the value it depends on in its deps.
- **Cache masks slow loads** — the token-usage `$facet` is ~7s cold / ~400ms
  cached; bust the cache (uncached filter combo) to observe the real load.
- **Healthcheck false-unhealthy** — `kodus_web` pings `/` (404 post-Next16) so
  it shows "unhealthy" while working.

## Reference
See memory `reference_perf_debug_flow` for the condensed version and
`project_frontend_perf_next16` for the concrete fixes shipped with this flow.

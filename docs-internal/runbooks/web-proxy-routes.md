# Runbook: Web proxy routes (`/api/proxy/*`)

> **When to read this:** a browser-side fetch is returning something
> unexpected (5xx, 404, CORS, ERR_CONTENT_DECODING_FAILED) OR you're
> adding a new backend endpoint and want to know if the frontend will
> reach it correctly OR you're triaging a selfhosted customer issue.

## Why proxy routes exist

Before this layer, client components resolved the backend URL at build
time via `next.config.js`'s `env:` block (which inlined
`WEB_HOSTNAME_API`, `WEB_PORT_API`, etc., into the JS bundle). That had
three problems:

1. **Self-hosted multi-replica**: the compiled bundle baked in a hostname
   that had to be the same in every replica. Operators hit 404s on
   `/_next/static/*` when they scaled the web to >1 replica.
2. **Hostname leak**: the internal backend address appeared literally
   inside the JS the browser downloaded. Anyone with devtools could
   read it.
3. **Per-customer config**: a single published image couldn't serve
   multiple customers with different hostnames without rebuilding.

Now the browser always fetches `https://<web-origin>/api/proxy/<target>/<path>`
on the same origin. The Next server receives that request, resolves the
real upstream URL from runtime `process.env`, and forwards.

## Architecture

```
┌─────────┐     same-origin       ┌────────────┐     internal net    ┌─────────┐
│ browser │ ─── /api/proxy/api ──▶│ Next server│ ─── kodus-api:3001 ▶│ backend │
└─────────┘                       └────────────┘                     └─────────┘
            (cookie, headers forward)        (adds Host, streams body)
```

Three proxies, one per upstream:

| Route prefix           | Upstream service        | Env vars resolved                                          |
|------------------------|-------------------------|------------------------------------------------------------|
| `/api/proxy/api/*`     | Kodus backend API       | `WEB_HOSTNAME_API`, `WEB_PORT_API`, `GLOBAL_API_CONTAINER_NAME` |
| `/api/proxy/mcp/*`     | MCP Manager service     | `WEB_HOSTNAME_MCP_MANAGER`, `WEB_PORT_MCP_MANAGER`, `GLOBAL_MCP_MANAGER_CONTAINER_NAME` |
| `/api/proxy/billing/*` | Billing service         | `WEB_HOSTNAME_BILLING`, `WEB_PORT_BILLING`, `GLOBAL_BILLING_CONTAINER_NAME` |

All three share `apps/web/src/app/api/proxy/_lib/create-proxy-handler.ts`.

## Key code paths

| File | Role |
|------|------|
| `apps/web/src/app/api/proxy/_lib/create-proxy-handler.ts` | Shared factory: normalization, denylist, rate limit, header handling, body streaming |
| `apps/web/src/app/api/proxy/{api,mcp,billing}/[...path]/route.ts` | Thin wrappers that configure the factory per upstream |
| `apps/web/src/core/utils/api-proxy.ts` | Client helper: `apiProxyPath("/foo") → "/api/proxy/api/foo"` |
| `apps/web/src/core/utils/helpers.ts` | `pathToApiUrl` — **dual-mode**: server → full upstream URL, client → `apiProxyPath(...)` |
| `apps/web/src/lib/auth/fetchers.ts` | `authUrl` helper — same dual-mode pattern for auth-adjacent calls |
| `apps/web/src/middleware.ts` | Matcher **excludes** `/api/proxy` — otherwise the auth middleware 307-redirects unauthenticated proxy calls (e.g. sign-up email check) |

## What the factory does per request

1. **Normalize path segments**. Reject `..`, `.`, null bytes → 404 without touching upstream.
2. **Denylist check**. Prefixes like `/admin`, `/internal`, `/metrics`, `/debug`, `/health/raw` are rejected with 404 (not 403 — indistinguishable from a typo for would-be probers).
3. **Rate limit**. Sliding window keyed by `authjs.session-token` cookie (fallback: `X-Forwarded-For`). Default: 120 req / 10 s per key. Returns 429 when exceeded.
4. **Strip `Host`** from the request headers (upstream needs its own vhost).
5. **Optional Bearer injection** (MCP proxy uses this — resolves NextAuth session server-side and overrides any Authorization header).
6. **Stream body** (with `duplex: "half"`) for non-GET/HEAD.
7. **Strip response encoding headers** (`content-encoding`, `content-length`, `transfer-encoding`). undici auto-decompresses the body; leaving those headers causes the browser to decode plaintext as gzip → `ERR_CONTENT_DECODING_FAILED`.

## Common failures & how to triage

### `ERR_CONTENT_DECODING_FAILED` on a proxy call

**Cause**: upstream response carried a `Content-Encoding` header (usually `gzip`) that reached the browser untouched, but undici already decompressed the body.

**Fix**: the factory strips those headers. If you still see it, check the response of `fetch` in the handler — a custom wrapper (Axios etc) around `fetch` may double-decode.

### 307 redirect loop on the sign-up page

**Cause**: `apps/web/src/middleware.ts` matcher doesn't exclude `/api/proxy`. Unauthenticated proxy calls get redirected to `/sign-in`.

**Fix**: verify `api/proxy` is in the negative-lookahead of the middleware matcher.

### `http://undefined/...` in the browser's Network tab

**Cause**: some module-level `pathToApiUrl("/foo")` ran on the client, where `process.env.WEB_HOSTNAME_API` is not defined (it's no longer in the `env:` block).

**Fix**: `pathToApiUrl` is dual-mode — in a client context it returns `apiProxyPath(path)`. If you're seeing `undefined`, someone probably imported the path string into a *custom* URL builder that bypasses `pathToApiUrl`. Grep for `process.env.WEB_HOSTNAME_API` in `apps/web/src`.

### 404 on a path that definitely exists on the backend

**Cause candidates** (in order):

1. Path is in the **denylist** (`/admin`, `/internal`, etc.) — audit `_lib/create-proxy-handler.ts`.
2. Path has `..` or `.` segments — the normalizer refuses them.
3. The upstream really returned 404 — check the request URL in the Network tab vs what the backend registered.

### 429 Too Many Requests

**Cause**: the client is making >120 requests within 10s on the same session. Usually a `useEffect` that re-runs unexpectedly.

**Fix**: find the offending hook. The limit is in `RATE_LIMIT` at the top of `_lib/create-proxy-handler.ts` and can be tuned if the default is too aggressive for legitimate flows.

### Internal hostname visible in the bundle

**Cause**: you shouldn't see this anymore, but if you do:

1. Check if something new was added to `next.config.js`'s `env:` block — that inlines at build time.
2. Check for module-scope literal strings like `"http://kodus_api:3001"` in client code.
3. Bundle inspection:
   ```bash
   cd apps/web/.next/static
   grep -rhE "(kodus_api|mcp\.internal|\.internal:)" .
   ```
   Expected output: nothing.

## Adding a new backend endpoint

1. Implement the endpoint in the backend (`/new-feature/foo`).
2. Call it from the frontend via the existing helpers — no proxy config needed as long as the path doesn't collide with a denylist prefix:

   ```ts
   // client component
   import { apiProxyPath } from "src/core/utils/api-proxy";
   const data = await fetch(apiProxyPath("/new-feature/foo")).then(r => r.json());

   // server component / action
   import { pathToApiUrl } from "src/core/utils/helpers";
   const data = await fetch(pathToApiUrl("/new-feature/foo")).then(r => r.json());
   ```

If the new endpoint is **sensitive and should not be exposed through
the proxy**, add its prefix to `denyPathPrefixes` in the relevant
`route.ts`.

## Testing changes

```bash
# unit: factory behaviour (normalization, denylist, rate limit, headers)
yarn test apps/web/src/app/api/proxy

# build: confirm Turbopack parses the server-only imports
cd apps/web && yarn build

# end-to-end on dev stack
yarn docker:start
open http://localhost:3000/sign-up   # tests the auth branch
open http://localhost:3000/settings/plugins   # tests the MCP proxy
```

## Selfhosted notes

- Single image serves every customer. No per-customer rebuild.
- `.env` in the installer sets `WEB_HOSTNAME_API=localhost` by default; the
  proxy resolves `localhost` to the container name via
  `GLOBAL_API_CONTAINER_NAME`. Same pattern for MCP and billing.
- If an operator puts a reverse proxy in front of the web container, no
  CORS config is needed for the backend — the browser only ever talks to
  the web origin.
- Scaling the web horizontally: the deterministic `BUILD_ID`
  (`next.config.js` `generateBuildId`) keeps static chunk hashes stable
  across replicas; sticky sessions are no longer required.

import type {
    KodusSession,
    Provider,
    ProviderRepoRef,
    TargetContext,
    TenantCredentials,
} from "./types.js";
import {
    ensureOk,
    http,
    registerSessionCookie,
    type HttpResponse,
} from "./http.js";
import { logger } from "./log.js";
import { settle } from "../providers/base.js";

const log = logger("onboarding");

interface LoginEnvelope {
    data?: { accessToken?: string; refreshToken?: string };
}

/**
 * Establish a NextAuth session cookie for the cloud web-proxy path.
 *
 * Cloud cells reach the API through `${webBaseUrl}/api/proxy/api`, whose route
 * ignores a client-sent `Authorization` header and derives the upstream Bearer
 * from the NextAuth session cookie (deleting the Authorization when there's no
 * session — the exact reason every authenticated matrix cell 401'd once the
 * web app started injecting the bearer in the proxy). We already hold the
 * `{accessToken, refreshToken}` from `/auth/login`; exchange them for a session
 * cookie via the SSO credentials provider (auth.ts: `AuthProviders.SSO`), then
 * register it so `http()` attaches it to every call carrying this bearer.
 *
 * Returns the `name=value; …` cookie string, or undefined if the handshake
 * didn't yield a session token (caller logs and proceeds — the subsequent
 * listTeams call surfaces the auth failure loudly rather than here).
 */
async function establishWebSession(
    webBaseUrl: string,
    accessToken: string,
    refreshToken: string,
): Promise<string | undefined> {
    const base = webBaseUrl.replace(/\/$/, "");

    // NextAuth's double-submit CSRF: token in the body must match the cookie.
    const csrf = await http<{ csrfToken?: string }>(
        `${base}/api/auth/csrf`,
        { timeoutMs: 20_000 },
    );
    const csrfToken = csrf.body?.csrfToken;
    const csrfCookie = cookiePairs(csrf.headers.getSetCookie());
    if (!csrfToken || !csrfCookie) {
        log.warn(
            `NextAuth CSRF handshake incomplete at ${base} (token=${!!csrfToken}, cookie=${!!csrfCookie})`,
        );
        return undefined;
    }

    // SSO credentials sign-in: swaps the API tokens for a session cookie.
    const form = new URLSearchParams({
        csrfToken,
        accessToken,
        refreshToken,
        callbackUrl: base,
        json: "true",
    });
    const cb = await http(`${base}/api/auth/callback/sso`, {
        method: "POST",
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: csrfCookie,
        },
        body: form.toString(),
        redirect: "manual",
        timeoutMs: 20_000,
    });

    const sessionCookie = cookiePairs(cb.headers.getSetCookie());
    const all = [csrfCookie, sessionCookie].filter(Boolean).join("; ");
    if (!/session-token/.test(all)) {
        log.warn(
            `SSO sign-in returned no session-token cookie (HTTP ${cb.status}) — cloud proxy auth will fail`,
        );
        return undefined;
    }
    return all;
}

/**
 * Reduce Set-Cookie header lines to a request `name=value; …` cookie string,
 * de-duped by cookie NAME keeping the LAST occurrence.
 *
 * NextAuth's middleware `auth()` wrapper AND the csrf route each emit an
 * `authjs.csrf-token` on `GET /api/auth/csrf`, but only the LAST matches the
 * `csrfToken` returned in the JSON body — and Auth.js reads the FIRST cookie
 * of a repeated name, so forwarding both fails the double-submit check with
 * `MissingCSRF`. Last-wins keeps the authoritative token. Chunked session
 * cookies (`…session-token.0/.1` for large JWTs) have distinct names, so
 * they're all preserved.
 */
function cookiePairs(setCookies: string[]): string {
    const jar = new Map<string, string>();
    for (const c of setCookies) {
        const pair = c.split(";")[0].trim();
        const eq = pair.indexOf("=");
        if (eq <= 0) continue;
        jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
    const segments = jwt.split(".");
    if (segments.length < 2) throw new Error("invalid JWT");
    const padded = segments[1] + "=".repeat((4 - (segments[1].length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    try {
        return JSON.parse(decoded) as Record<string, unknown>;
    } catch (err) {
        throw new Error(`Could not decode JWT payload: ${(err as Error).message}`);
    }
}

// Signs up a fresh Kodus tenant. Used by smoke/matrix runs against
// self-hosted droplets so every (provider × target) cell starts with a
// virgin organization — no leftover integrations, repos, or rules from
// previous cells. Without this, re-running the matrix against the same
// droplet would re-use whichever tenant happened to onboard first, and
// `getTypeIntegration` (which doesn't filter by platform) would route
// dispatches to whatever provider was registered first — silently
// breaking every subsequent provider's webhook auto-register flow.
export async function signUp(
    target: TargetContext,
    creds: { email: string; password: string; name?: string },
): Promise<void> {
    log.info(`Signing up tenant ${creds.email}`);
    // Kodus's API has been spelled both `/auth/signUp` (camelCase) and
    // `/auth/signup` (lowercase) at different versions — try the canonical
    // form first, fall back to the lowercase variant on a 404.
    let resp = await http(`${target.apiBaseUrl}/auth/signUp`, {
        method: "POST",
        body: {
            name: creds.name ?? `e2e-${Date.now()}`,
            email: creds.email,
            password: creds.password,
        },
        timeoutMs: 30_000,
    });
    if (resp.status === 404) {
        resp = await http(`${target.apiBaseUrl}/auth/signup`, {
            method: "POST",
            body: {
                name: creds.name ?? `e2e-${Date.now()}`,
                email: creds.email,
                password: creds.password,
            },
            timeoutMs: 30_000,
        });
    }
    // 409 (or any 4xx that looks like "already exists") is idempotent OK
    // for our purposes — the tenant exists, we'll log in next. Kodus has
    // shipped this as 409 and as 400 with different message shapes at
    // various versions, so match loosely on the response text.
    if (resp.status === 409 || (resp.status === 400 && /already|exists/i.test(resp.raw))) {
        log.info(`Tenant ${creds.email} already exists — reusing`);
        return;
    }
    ensureOk(resp, "onboarding:signUp");
    log.ok(`Tenant ${creds.email} created`);
}

export async function login(
    target: TargetContext,
    creds: TenantCredentials,
): Promise<KodusSession> {
    log.info(`Logging in as ${creds.email} via ${target.apiBaseUrl}`);
    const resp = await http<LoginEnvelope>(
        `${target.apiBaseUrl}/auth/login`,
        {
            method: "POST",
            body: { email: creds.email, password: creds.password },
            timeoutMs: 20_000,
        },
    );
    ensureOk(resp, "onboarding:login");
    const accessToken = resp.body.data?.accessToken;
    if (!accessToken) {
        throw new Error(
            `Login response missing accessToken: ${resp.raw.slice(0, 400)}`,
        );
    }
    const payload = decodeJwtPayload(accessToken);
    const organizationId = String(payload.organizationId ?? "");
    if (!organizationId) {
        throw new Error("JWT payload missing organizationId");
    }

    // Cloud reaches the API through the web app's `/api/proxy/api`, which
    // derives the upstream Bearer from the NextAuth session cookie and strips
    // a client-sent Authorization. A raw Bearer never survives the proxy, so
    // exchange the API tokens for a session cookie and register it; `http()`
    // then carries it on every call made with this bearer. Direct
    // (self-hosted / local) targets skip this — they hit the API without a
    // proxy and the Bearer works as-is.
    const refreshToken = resp.body.data?.refreshToken;
    if (target.apiBaseUrl.includes("/api/proxy/") && refreshToken) {
        try {
            const cookie = await establishWebSession(
                target.webBaseUrl,
                accessToken,
                refreshToken,
            );
            if (cookie) {
                // Scope the cookie to the API host (the proxy lives on the web
                // host, e.g. qa.web.kodus.io, which is also apiBaseUrl's host).
                const host = new URL(target.apiBaseUrl).host;
                registerSessionCookie(accessToken, cookie, host);
            }
        } catch (err) {
            log.warn(
                `Failed to establish NextAuth session for cloud proxy (${target.webBaseUrl}): ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        }
    }

    // 30s envelope: under cloud QA load /team/ can hit the proxy
    // read-timeout window and abort with "This operation was aborted"
    // even though the underlying request would have completed in <1s.
    // Observed 2026-05-21 on the full matrix run b4hvjc1wv: login
    // succeeded but the next call (/team/) aborted at ~15s. Bumping
    // to 30s removes the flake without masking real failures (QA's
    // own gateway times out at 60s upstream).
    const teamsResp = await http<{ data: { uuid: string }[] }>(
        `${target.apiBaseUrl}/team/`,
        {
            headers: { Authorization: `Bearer ${accessToken}` },
            timeoutMs: 30_000,
        },
    );
    ensureOk(teamsResp, "onboarding:listTeams");
    const teamId = teamsResp.body.data?.[0]?.uuid;
    if (!teamId) {
        throw new Error("No team found for the logged-in user");
    }
    log.ok(`org=${organizationId} team=${teamId}`);
    return { accessToken, organizationId, teamId };
}

// The cloud tenants are PERSISTENT (Stripe ties each license tier to a real
// account, so we can't sign up a fresh one per run like self-hosted does).
// Over time a tenant accumulates code-management integrations from earlier
// runs of OTHER providers on the same org — we observed e2e-paid-gh stacked
// with GITLAB → BITBUCKET → AZURE_REPOS → GITHUB. Kodus's getTypeIntegration
// resolves by CATEGORY (not platform), picking the FIRST code-management
// integration, so the stale gitlab/bitbucket one wins and the github review
// never fires (0 webhook, no review) — deterministically, every run.
//
// Before registering our integration, drop any code-management integration
// whose platform differs from the one we're about to connect. delete-
// integration removes one at a time (the category's current first), so loop
// until the active platform is ours or there's nothing left. Self-hosted
// uses a fresh tenant, so this is a no-op there (at most our own platform).
// Reads the tenant's ACTIVE code-management platform (uppercased), or ""
// when none is connected. Shared by clearConflictingIntegrations and the
// registerIntegration timeout-recovery path below.
async function activeCodeManagementPlatform(
    target: TargetContext,
    session: KodusSession,
): Promise<string> {
    const resp = await http<{ data?: Array<{ platformName?: string; category?: string }> }>(
        `${target.apiBaseUrl}/integration/connections?teamId=${encodeURIComponent(session.teamId)}`,
        { headers: { Authorization: `Bearer ${session.accessToken}` }, timeoutMs: 15_000 },
    );
    const active = (resp.body?.data ?? []).find(
        (c) => (c.category ?? "CODE_MANAGEMENT") === "CODE_MANAGEMENT",
    );
    return (active?.platformName ?? "").toUpperCase();
}

async function clearConflictingIntegrations(
    target: TargetContext,
    provider: Provider,
    session: KodusSession,
): Promise<void> {
    const wanted = provider.integrationType.toUpperCase();
    for (let i = 0; i < 8; i++) {
        const platform = await activeCodeManagementPlatform(target, session);
        if (!platform || platform === wanted) return; // clean or already ours
        log.info(`Dropping stale ${platform} integration before connecting ${wanted}`);
        // The integration being deleted may be cached as "registered" by an
        // earlier cell on this org — the cache must not outlive the
        // integration (same invariant as deleteRepo → invalidateRegisteredRepo),
        // or a later platform-A cell after an A → B switch would hit the
        // stale entry and skip re-registering. Invalidate BEFORE the DELETE:
        // if the DELETE fails we merely re-register needlessly.
        invalidateRegisteredIntegrations(target.apiBaseUrl, session.organizationId);
        await http(
            `${target.apiBaseUrl}/code-management/delete-integration?teamId=${encodeURIComponent(session.teamId)}`,
            { method: "DELETE", headers: { Authorization: `Bearer ${session.accessToken}` }, timeoutMs: 20_000 },
        );
        await new Promise((r) => setTimeout(r, 1_500));
    }
}

// Within a single matrix run a tenant's integration only needs to be
// registered ONCE — mirroring registeredRepoCache above. Re-POSTing
// /code-management/auth-integration on every scenario makes the backend
// re-validate the token against the provider's API each time; ~20
// scenarios (plus the runner's transient retries, plus http()'s own
// transport retries when a call hangs) is enough for Bitbucket Cloud to
// start throttling the shared test account's auth calls — observed on
// release run 28888685303 where every scenario after the 4th died at
// "Registering BITBUCKET integration" with 30s-timeout aborts. Caching
// per (apiBaseUrl, org, platform) means one validation per tenant per
// run. Keyed on apiBaseUrl so hermetic mock servers (unique localhost
// ports) never share a slot; scenarios that use throwaway orgs (e.g.
// centralized-config-sync, which delete-integrations at teardown) have
// their own organizationId and therefore their own key.
const registeredIntegrationCache = new Set<string>();

// Drops every integration-cache entry for an org, any platform. Called by
// clearConflictingIntegrations when it deletes the org's active integration.
function invalidateRegisteredIntegrations(
    apiBaseUrl: string,
    organizationId: string,
): void {
    const prefix = `${apiBaseUrl}:${organizationId}:`;
    for (const key of registeredIntegrationCache) {
        if (key.startsWith(prefix)) registeredIntegrationCache.delete(key);
    }
}

export async function registerIntegration(
    target: TargetContext,
    provider: Provider,
    session: KodusSession,
): Promise<void> {
    const cacheKey = `${target.apiBaseUrl}:${session.organizationId}:${provider.integrationType}`;
    if (registeredIntegrationCache.has(cacheKey)) {
        log.info(
            `${provider.integrationType} integration already registered this run — reusing (skips provider-side token re-validation)`,
        );
        return;
    }
    // Cloud only: persistent tenants accumulate cross-provider integrations
    // that hijack getTypeIntegration. Self-hosted's fresh tenant never does.
    if (target.target === "cloud") {
        await clearConflictingIntegrations(target, provider, session);
    }
    log.info(`Registering ${provider.integrationType} integration`);
    const extras = provider.authExtraFields?.() ?? {};
    // OAuth path (GitHub App today): the backend expects `code` =
    // installation_id and ignores `token` entirely. See
    // github.service.ts:authenticateWithCodeOauth — it calls
    // appOctokit.auth({ type: 'installation', installationId: params.code }).
    // Token path (PAT / app-password): payload carries the secret as
    // `token`, no `code` field.
    const authMode = provider.authMode();
    const isOAuth = authMode === "oauth";
    const body: Record<string, unknown> = {
        integrationType: provider.integrationType,
        authMode,
        organizationAndTeamData: {
            organizationId: session.organizationId,
            teamId: session.teamId,
        },
        ...extras,
    };
    if (isOAuth) {
        body.code = provider.authToken();
    } else {
        body.token = provider.authToken();
    }
    let resp: HttpResponse<{ data: { status?: string } }>;
    try {
        resp = await http<{ data: { status?: string } }>(
            `${target.apiBaseUrl}/code-management/auth-integration`,
            {
                method: "POST",
                headers: { Authorization: `Bearer ${session.accessToken}` },
                body,
                timeoutMs: 60_000,
            },
        );
    } catch (err) {
        // http() only rethrows after exhausting its transport retries —
        // meaning every attempt hung past the timeout ("This operation was
        // aborted"). auth-integration's server side validates the token
        // against the provider and can outlive our client timeout while
        // still COMMITTING the integration (same eventual-consistency
        // shape finishOnboarding handles for proxy 504s). Before failing
        // the scenario, poll the connections list: if our platform landed,
        // the registration succeeded and we proceed.
        if (await pollIntegrationLanded(target, provider, session)) {
            log.info(
                `registerIntegration: POST timed out but the ${provider.integrationType} integration landed server-side — continuing`,
            );
            registeredIntegrationCache.add(cacheKey);
            return;
        }
        throw err;
    }
    // Proxy read-timeout statuses (504 on qa.web.kodus.io after 60s, etc.):
    // the backend keeps working and usually commits — same recovery as the
    // client-timeout path above and as finishOnboarding's proxy handling.
    if (PROXY_PENDING_STATUSES.has(resp.status)) {
        if (await pollIntegrationLanded(target, provider, session)) {
            log.info(
                `registerIntegration: proxy ${resp.status} but the ${provider.integrationType} integration landed server-side — continuing`,
            );
            registeredIntegrationCache.add(cacheKey);
            return;
        }
    }
    ensureOk(resp, "onboarding:registerIntegration");
    if (resp.body.data?.status !== "SUCCESS") {
        throw new Error(
            `auth-integration did not return SUCCESS: ${resp.raw.slice(0, 400)}`,
        );
    }
    registeredIntegrationCache.add(cacheKey);
}

// Post-timeout recovery probe for registerIntegration: true when the
// wanted platform shows up as the tenant's active code-management
// integration within ~60s. Short window on purpose — if the backend is
// genuinely stuck we want the scenario's own failure, not a long stall.
async function pollIntegrationLanded(
    target: TargetContext,
    provider: Provider,
    session: KodusSession,
): Promise<boolean> {
    const wanted = provider.integrationType.toUpperCase();
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        const platform = await activeCodeManagementPlatform(
            target,
            session,
        ).catch(() => "");
        if (platform === wanted) return true;
        await new Promise((r) => setTimeout(r, 10_000));
    }
    return false;
}

// Within a single matrix run a tenant's repo only needs to be registered
// ONCE. Re-POSTing /code-management/repositories on every scenario makes
// Kodus delete+recreate that repo's GitHub webhook each time (see
// github.service.ts createPullRequestWebhook: it lists → deletes → creates
// the hook with the same URL). That recreate opens a brief blind spot: a
// PR opened right then fires its `opened` event at the about-to-be-deleted
// hook, and GitHub never redelivers it to the new one — so the review
// never starts and the scenario times out waiting for a heartbeat that can
// no longer come. Caching the registration per (target, provider, org,
// repo) means only the FIRST scenario per tenant pays the webhook churn;
// every later scenario reuses the stable hook. (The first scenario's lone
// churn completes before it opens its PR, so the new hook is already live.)
const registeredRepoCache = new Map<string, ProviderRepoRef>();

// Drops every cache entry for `fullName`, regardless of tenant/provider.
// Needed by the throwaway-repo flows (trial-managed-review etc.): the repo
// name is deterministic per run, so when a retry deletes and RECREATES the
// repo under the same name, a stale cache hit would skip the registration
// POST — and with it the webhook creation on the NEW repo. The retry then
// polls a webhook-less repo and fails by construction (observed on nightly
// run 28926099375: attempt 2 logged "already registered — reusing" against
// a just-recreated repo and no review could ever arrive).
export function invalidateRegisteredRepo(fullName: string): void {
    for (const key of registeredRepoCache.keys()) {
        if (key.endsWith(`:${fullName}`)) registeredRepoCache.delete(key);
    }
}

export async function registerRepo(
    target: TargetContext,
    provider: Provider,
    session: KodusSession,
    opts?: { forceRecreate?: boolean },
): Promise<ProviderRepoRef> {
    const repoRef = await provider.repoRef();
    // Key on apiBaseUrl (not target.target) so each hermetic mock server
    // — every integration test spins a fresh one on a unique localhost
    // port — gets its own cache slot and never reuses a prior test's
    // registration. Real runs share one apiBaseUrl, where organizationId
    // disambiguates tenants.
    const cacheKey = `${target.apiBaseUrl}:${provider.name}:${session.organizationId}:${repoRef.full_name}`;
    // forceRecreate bypasses the cache: onboarding-webhook-registration
    // deletes the repo's webhook on purpose and then asserts registerRepo
    // recreated it, so it MUST hit the real POST (the cache exists exactly
    // to skip that POST's webhook churn, which would otherwise leave the
    // just-deleted hook gone and fail that scenario's assertion).
    const cached = opts?.forceRecreate
        ? undefined
        : registeredRepoCache.get(cacheKey);
    if (cached) {
        log.info(
            `Repo ${cached.full_name} already registered this run — reusing (skips webhook-churning re-POST)`,
        );
        return cached;
    }
    log.info(`Looking up ${repoRef.full_name} in available repos`);
    const listResp = await http<{
        data: Array<{
            full_name?: string;
            id: string | number;
            name?: string;
            // Bitbucket-shape: Kodus exposes org via `organizationName`
            // (workspace slug) instead of folding it into full_name.
            organizationName?: string;
        }>;
    }>(
        `${target.apiBaseUrl}/code-management/repositories/org?teamId=${encodeURIComponent(session.teamId)}`,
        {
            headers: { Authorization: `Bearer ${session.accessToken}` },
            timeoutMs: 30_000,
        },
    );
    ensureOk(listResp, "onboarding:listRepos");
    // Each provider Kodus integrates with returns a slightly different
    // repo shape on /repositories/org. Try several fields so we don't
    // have to maintain a per-provider matcher in the test runner:
    //   * github exposes `full_name` ("org/repo")
    //   * bitbucket exposes `organizationName` (workspace slug) + `name`
    //     and we synthesize the same "workspace/repo" form locally
    //   * azure-repos / gitlab also exposes name only — match by id (with
    //     UUID-brace stripping for parity with sanitizeUUID server-side).
    const stripBraces = (id: unknown): string =>
        String(id ?? "").replace(/^\{|\}$/g, "");
    const wantedFullName = repoRef.full_name;
    const wantedId = stripBraces(repoRef.id);
    const found =
        listResp.body.data?.find((r) => r.full_name === wantedFullName) ??
        listResp.body.data?.find(
            (r) =>
                r.organizationName != null &&
                r.name != null &&
                `${r.organizationName}/${r.name}` === wantedFullName,
        ) ??
        listResp.body.data?.find((r) => stripBraces(r.id) === wantedId);
    if (!found) {
        // Keep the response shape in the error so a future provider-shape
        // mismatch is debuggable without re-instrumenting. Truncate to
        // avoid spamming logs on accounts with hundreds of repos.
        throw new Error(
            `Repo ${repoRef.full_name} not in integration's available list. ` +
                `Got ${listResp.body.data?.length ?? 0} entries: ` +
                JSON.stringify(
                    listResp.body.data?.slice(0, 5).map((r) => ({
                        id: r.id,
                        full_name: r.full_name,
                        name: r.name,
                        organizationName: r.organizationName,
                    })),
                ).slice(0, 800),
        );
    }
    // POST /code-management/repositories sometimes 400s with
    // `"(intermediate value) is not iterable"` when it runs <8s after
    // auth-integration — server-side teamAutomationService.find()
    // returns null on the still-uninitialized doc and the use-case
    // tries to spread that null. Same race the cloud setup-tenants
    // script wraps in setup-tenants.ts:405-419; observed today
    // (2026-05-20) on a fresh self-hosted droplet right after
    // registerIntegration. Wait + retry once on that specific symptom.
    const postRegisterRepo = () =>
        http<{ data: { status: boolean } }>(
            `${target.apiBaseUrl}/code-management/repositories`,
            {
                method: "POST",
                headers: { Authorization: `Bearer ${session.accessToken}` },
                body: {
                    teamId: session.teamId,
                    type: "replace",
                    repositories: [found],
                },
                timeoutMs: 30_000,
            },
        );

    let registerResp = await postRegisterRepo();
    if (
        registerResp.status === 400 &&
        /is not iterable/.test(registerResp.raw)
    ) {
        log.info(
            "registerRepo hit the post-integration race ('not iterable'); waiting 15s and retrying once",
        );
        await new Promise((r) => setTimeout(r, 15_000));
        registerResp = await postRegisterRepo();
    }
    ensureOk(registerResp, "onboarding:registerRepo");
    if (!registerResp.body.data?.status) {
        throw new Error(
            `Repo registration failed: ${registerResp.raw.slice(0, 400)}`,
        );
    }
    // Normalize back to ProviderRepoRef. `found` may not carry `full_name`
    // (Bitbucket case — Kodus folds workspace + name separately); fall back
    // to the originally-requested form so callers always have a stable
    // "workspace/repo" handle to log against.
    const normalized: ProviderRepoRef = {
        id: found.id,
        name: found.name ?? repoRef.name,
        full_name: found.full_name ?? repoRef.full_name,
    };
    log.ok(`Repo ${normalized.full_name} registered`);
    registeredRepoCache.set(cacheKey, normalized);
    return normalized;
}

// Codes the cloud QA proxy (or any nginx in front of Kodus) returns
// when the upstream is still processing the request past the proxy's
// read-timeout. On qa.web.kodus.io the timeout is 60s; bitbucket
// onboarding regularly runs past that because the rule-generation path
// makes N sequential Bitbucket Cloud API calls (objectively slower
// than github/gitlab) plus an LLM call. The backend still finishes
// successfully — confirmed 2026-05-20 by reading kody-rules from DB
// after a 504. So we treat these statuses as "ack, still working" and
// fall through to polling kodyLearningStatus on PLATFORM_CONFIGS.
const PROXY_PENDING_STATUSES = new Set([502, 503, 504, 524, 408]);

// Match the use-case enum (libs/organization/domain/parameters/types/
// configValue.type.ts).
type KodyLearningStatus =
    | "enabled"
    | "disabled"
    | "generating_rules"
    | "generating_config";

interface PlatformConfigsResponse {
    data?: {
        configValue?: { kodyLearningStatus?: KodyLearningStatus };
    };
    configValue?: { kodyLearningStatus?: KodyLearningStatus };
}

async function readKodyLearningStatus(
    target: TargetContext,
    session: KodusSession,
): Promise<KodyLearningStatus | undefined> {
    const url = `${target.apiBaseUrl}/parameters/find-by-key?key=platform_configs&teamId=${encodeURIComponent(session.teamId)}`;
    const resp = await http<PlatformConfigsResponse>(url, {
        headers: { Authorization: `Bearer ${session.accessToken}` },
        timeoutMs: 10_000,
    });
    if (resp.status < 200 || resp.status >= 300) {
        return undefined;
    }
    const root = (resp.body ?? {}) as PlatformConfigsResponse;
    return (
        root.data?.configValue?.kodyLearningStatus ??
        root.configValue?.kodyLearningStatus
    );
}

export async function finishOnboarding(
    target: TargetContext,
    session: KodusSession,
    repo: ProviderRepoRef,
): Promise<void> {
    log.info("Finishing onboarding");
    // finish-onboarding does substantial work synchronously: generates
    // per-repo Kody rules via LLM and syncs rules from repo files. The
    // upstream HTTP path can sit past nginx's 60s read-timeout on
    // qa.web.kodus.io (cloud) or any reverse-proxy a self-hosted
    // operator runs in front of the API. The work itself still
    // completes — `generate-kody-rules.use-case` writes
    // `kodyLearningStatus = ENABLED` on the platform_configs parameter
    // when it's done. Treat proxy-timeout statuses as "queued, will
    // poll for completion" instead of failing immediately.
    const resp = await http(
        `${target.apiBaseUrl}/code-management/finish-onboarding`,
        {
            method: "POST",
            headers: { Authorization: `Bearer ${session.accessToken}` },
            body: {
                teamId: session.teamId,
                reviewPR: false,
                repositoryId: String(repo.id),
                repositoryName: repo.name ?? repo.full_name,
            },
            timeoutMs: 360_000,
        },
    );

    if (resp.status >= 200 && resp.status < 300) {
        // 200 OK is premature: the API returns success before the
        // server-side team_automation row is fully committed/
        // propagated. If the next thing the scenario does is open a
        // PR (which most do), the webhook arrives while
        // validate-prerequisites stage still sees "no active
        // code-review automation" and silently drops the event — no
        // log, no comment on the PR, the test polls for 12 min and
        // times out. Verified 2026-05-20 on the self-hosted matrix:
        // MR opened 1s after 200 OK was silently dropped, identical
        // MR opened 25 min later got the normal "Code Review
        // Started!" placeholder. 10s sleep clears the race for every
        // observed case. See task #84 for the corresponding server-
        // side fix (validate-prerequisites should retry with backoff
        // when no automation is found).
        await settle(10_000);
        await resetCodeReviewConfig(target, session);
        return;
    }

    if (!PROXY_PENDING_STATUSES.has(resp.status)) {
        // Real error (4xx auth/validation, 5xx app crash) — fail loudly
        // as before, including the response body so the failure is
        // diagnosable.
        ensureOk(resp, "onboarding:finishOnboarding");
        return; // unreachable — ensureOk threw
    }

    log.info(
        `finishOnboarding got HTTP ${resp.status} from the proxy — polling kodyLearningStatus to see if the backend finished anyway`,
    );

    // Poll for up to 5 minutes. Observed real-world latency for
    // bitbucket onboarding is ~75-90s end-to-end (the slowest seen
    // path); 300s adds margin for an LLM-side hiccup without hiding a
    // genuine hang. Poll every 10s.
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
        const status = await readKodyLearningStatus(target, session).catch(
            () => undefined,
        );
        if (status === "enabled") {
            log.info(
                `finishOnboarding eventually consistent: kodyLearningStatus=enabled (after proxy ${resp.status})`,
            );
            // Same race guard as the 2xx happy-path: kodyLearningStatus
            // flips before team_automation is fully committed/propagated.
            // 10s buffer keeps a webhook fired immediately after this
            // call from being silently dropped by validate-prerequisites.
            await new Promise((r) => setTimeout(r, 10_000));
            await resetCodeReviewConfig(target, session);
            return;
        }
        await new Promise((r) => setTimeout(r, 10_000));
    }

    throw new Error(
        `onboarding:finishOnboarding: HTTP ${resp.status} from proxy AND kodyLearningStatus did not become 'enabled' within 300s polling. Backend appears stuck.`,
    );
}

// Restores the tenant's code-review config to the canonical "auto-review
// enabled" baseline. Called at two points:
//
//   1. At the end of `finishOnboarding` — handles fresh self-hosted tenants
//      that signed up via /auth/signup, which land with
//      `code_review_config.configs.automatedReviewActive` unset (null).
//      `validate-config.stage.ts:486` treats null as falsy and silently
//      skips every PR-opened review, so without this the very first PR a
//      scenario opens times out blaming "no review activity".
//
//   2. At the start of any scenario that depends on auto-review being on
//      (code-review-basic, kody-rules-create-and-apply, license-attribution,
//      per-seat-license-toggle). Defense-in-depth: if a previous cell on
//      the same tenant (matrix tenants are deterministic per provider) left
//      `automatedReviewActive=false` behind — e.g. command-review's finally
//      didn't run after a kill-9, or the runner aborted mid-restore — the
//      next scenario explicitly resets state and isn't penalized for what
//      its predecessor broke.
//
// Cloud QA tenants are seeded once by `setup-tenants.ts` and stay; we don't
// recycle them per run. Self-hosted tenants live in our droplet and could
// in theory be recycled, but for the same reason — they outlive a single
// matrix run — they're treated the same way. The right invariant in both
// targets is "each scenario asserts its preconditions explicitly", which is
// what this helper makes cheap.
//
// Best-effort: if the API call fails the scenario will still surface the
// downstream "no review" symptom, which is the existing failure shape.
export async function resetCodeReviewConfig(
    target: TargetContext,
    session: KodusSession,
): Promise<void> {
    try {
        const resp = await http(
            `${target.apiBaseUrl}/parameters/create-or-update-code-review`,
            {
                method: "POST",
                headers: { Authorization: `Bearer ${session.accessToken}` },
                body: {
                    organizationAndTeamData: { teamId: session.teamId },
                    configValue: { automatedReviewActive: true },
                },
                timeoutMs: 20_000,
            },
        );
        if (resp.status < 200 || resp.status >= 300) {
            log.info(
                `resetCodeReviewConfig: non-2xx response (${resp.status}); continuing — scenario will surface downstream review timeout if this didn't stick`,
            );
        }
    } catch (err) {
        log.info(
            `resetCodeReviewConfig: ${
                (err as Error).message
            } — continuing (best-effort)`,
        );
    }
}

// Assigns the PR author (the PAT/app user this run opens PRs as) a license
// seat on self-hosted, so the review pipeline doesn't skip every PR.
//
// Why this is needed: a self-hosted droplet provisioned with a valid
// `KODUS_LICENSE_KEY` runs in *licensed* mode, which enforces per-seat
// access (permissionValidation.service.ts:291). When the PR author's git id
// isn't in `getAllUsersWithLicense()`, `ValidatePrerequisitesStage` aborts
// the review with `USER_NOT_LICENSED` — the org default
// `auto_license_assignment.enabled=false` means there's no auto-grant — and
// Kody only leaves a 👎 reaction. The review scenarios poll for *comments*,
// so they misread that skip as "pipeline ran, 0 findings". Onboarding never
// assigns a seat, so we do it explicitly here. (Before the license var-name
// fix the key wasn't read → invalid license → Community Edition → no seat
// enforcement, which is why this was previously latent.)
//
// gitId/gitTool come from the provider in the exact shape Kodus stores as
// `pullRequest.user.id` from the webhook `sender.id` (see
// Provider.currentUserId): the same identity the pipeline checks the seat
// against. The body matches POST /license/assign (license.controller.ts).
//
// Self-hosted only — on cloud, seats are wired through Stripe/billing, not
// SelfHostedLicenseService, and this endpoint behaves differently. Idempotent
// and best-effort: in Community Edition (no/invalid license) assignLicense
// returns false → the user lands in `failed` and the review runs anyway, so
// a non-success response is expected, not an error. Scenarios that drive seat
// state themselves (per-seat-license-toggle) must NOT call this.
export async function ensureLicenseSeat(
    target: TargetContext,
    session: KodusSession,
    provider: Provider,
): Promise<void> {
    if (target.target !== "self-hosted") return;
    try {
        const gitId = await provider.currentUserId();
        if (!gitId) {
            log.info(
                `ensureLicenseSeat: provider ${provider.name} returned empty currentUserId — skipping (review may be skipped if licensed)`,
            );
            return;
        }
        const gitTool = provider.licenseGitTool();
        const resp = await http<{
            data?: { successful?: unknown[]; failed?: unknown[] };
        }>(`${target.apiBaseUrl}/license/assign`, {
            method: "POST",
            headers: { Authorization: `Bearer ${session.accessToken}` },
            body: {
                users: [{ gitId, gitTool, licenseStatus: "active" }],
            },
            timeoutMs: 15_000,
        });
        if (resp.status < 200 || resp.status >= 300) {
            log.info(
                `ensureLicenseSeat: non-2xx (${resp.status}) assigning seat to ${gitTool}:${gitId}; continuing — CE-mode tenants don't need it, licensed tenants will surface a skipped review`,
            );
        }
    } catch (err) {
        log.info(
            `ensureLicenseSeat: ${
                (err as Error).message
            } — continuing (best-effort)`,
        );
    }
}

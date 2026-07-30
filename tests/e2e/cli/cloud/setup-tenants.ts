/* eslint-disable no-console */
/**
 * Seeds the persistent E2E tenants on the QA cloud (qa.web.kodus.io)
 * that the cloud matrix smoke runs against. Each tenant is
 * single-provider and single-tier so it mirrors the self-hosted
 * isolation pattern.
 *
 * Usage:
 *   pnpm run cloud:setup-tenants                    # all tenants
 *   CLOUD_SETUP_ONLY=e2e-paid-gh@kodus.io \     # one tenant
 *     pnpm run cloud:setup-tenants
 *
 * Idempotent: signUp() returns silently on 409, integration POST
 * upserts in place, repo registration is idempotent on the Kodus side.
 *
 * Output: ~/.kodus-dev/cloud-tenants.json — one JSON object per
 * tenant with email/password/organizationId/teamId. Read by the
 * matrix runner in lib/runner.ts:resolveTenantForCell.
 *
 * Stripe upgrade (paid/trial tiers): NOT yet automated — see TODO in
 * ensureLicenseTier(). For now, the script seeds the tenant on the
 * default free tier. The matrix cell for paid will fail until upgrade
 * is implemented OR an admin endpoint to set tier is exposed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
    finishOnboarding,
    login,
    registerIntegration,
    registerRepo,
    signUp,
} from "../../lib/onboarding.js";
import { http } from "../../lib/http.js";
import { makeProvider } from "../../providers/index.js";
import {
    CLOUD_TENANTS,
    type TenantSpec,
} from "../../lib/cloud-tenant-registry.js";
import type { KodusSession, TargetContext } from "../../lib/types.js";

const QA_WEB_URL =
    process.env.CLOUD_WEB_URL?.replace(/\/$/, "") ?? "https://qa.web.kodus.io";

// Cloud QA proxies API calls through `/api/proxy/api/<path>`. The
// helpers in lib/onboarding.ts append paths like `/auth/signUp` to the
// configured apiBaseUrl, so the base must end at `/api` (not `/api/proxy`).
const QA_API_BASE_URL =
    process.env.CLOUD_API_URL?.replace(/\/$/, "") ??
    `${QA_WEB_URL}/api/proxy/api`;

const CREDS_FILE = join(homedir(), ".kodus-dev", "cloud-tenants.json");

// Shared password for all seeded tenants. Stored in plaintext in the
// gitignored creds file — fine for QA, never use for prod.
const SHARED_PASSWORD =
    process.env.CLOUD_SETUP_PASSWORD ?? "E2eCloud!2026Smoke";

// Tenant registry + the github repo-isolation invariant now live in
// lib/cloud-tenant-registry.ts so the matrix runner can fall back to the
// SAME canonical (provider, license) → repoFullName mapping when the
// CLOUD_TENANTS_JSON secret is stale (see the registry header for the
// 2026-06-03 environment-secret shadowing incident this guards against).
const TENANTS: TenantSpec[] = CLOUD_TENANTS;


interface SavedTenant extends TenantSpec {
    password: string;
    organizationId?: string;
    teamId?: string;
    integrationConnected?: boolean;
    repoRegistered?: boolean;
    onboardingFinished?: boolean;
    tierUpgraded?: boolean;
    seededAt: string;
}

function readSavedCreds(): SavedTenant[] {
    if (!existsSync(CREDS_FILE)) return [];
    try {
        const raw = readFileSync(CREDS_FILE, "utf8");
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as SavedTenant[]) : [];
    } catch (err) {
        console.warn(
            `[warn] could not parse ${CREDS_FILE}: ${(err as Error).message}. Starting fresh.`,
        );
        return [];
    }
}

function writeSavedCreds(creds: SavedTenant[]): void {
    mkdirSync(dirname(CREDS_FILE), { recursive: true });
    writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

function upsertCreds(creds: SavedTenant[], next: SavedTenant): SavedTenant[] {
    const idx = creds.findIndex((c) => c.email === next.email);
    if (idx >= 0) {
        creds[idx] = { ...creds[idx], ...next };
        return creds;
    }
    return [...creds, next];
}

function targetForCloud(): TargetContext {
    return {
        target: "cloud",
        apiBaseUrl: QA_API_BASE_URL,
        webBaseUrl: QA_WEB_URL,
    };
}

// `/auth/signUp` does NOT create a billing record — the UI signup flow
// calls `/api/proxy/billing/trial` separately (likely from the post-
// signup setup wizard our HTTP path skips). Without that call the
// tenant has no subscription at all and `validate-org-license`
// returns 400 — which Kodus's pipeline treats as "no license",
// equivalent to `free` for the license-attribution gate.
//
// Tier handling per matrix label:
//   - `free`            → leave subscription empty (= "trial expired,
//                          no BYOK"). Gate blocks; Kody posts the
//                          trial-ended notice.
//   - `community-byok`  → leave subscription empty BUT configure BYOK
//                          (`/organization-parameters/create-or-update`
//                          with key=byok_config). Gate allows reviews
//                          using the org's own LLM key; 10-rule limit.
//   - `trial`           → activate the trial billing record via
//                          `POST /api/proxy/billing/trial` (byok:false).
//                          Status=trial, valid while the 14-day window is
//                          open; exercises the trial-period gate.
//   - `paid`            → exercised as BYOK (we deliberately do NOT test
//                          the platform-managed LLM path). Same three-step
//                          dance as community-byok → ends ACTIVE/free_byok,
//                          which never expires. The real Stripe checkout
//                          (free→paid ACTIVE via Stripe) lives in the
//                          dedicated stripe-checkout scenario, not here.
async function ensureLicenseTier(
    target: TargetContext,
    session: KodusSession,
    tenant: TenantSpec,
): Promise<boolean> {
    if (tenant.license === "free") return true;
    // `paid` is exercised as a BYOK tenant (decision: we don't test the
    // platform-managed LLM path). It takes the SAME three-step BYOK dance
    // as community-byok, which is what makes it robust in CI: the final
    // /migrate-to-free flips the row to planType=free_byok AND
    // subscriptionStatus=ACTIVE — so it NEVER expires. The old `paid`
    // path (/billing/trial byok:false) created a 14-day TRIAL row that
    // createTrialLicense refuses to renew (throws "já existe"), so a
    // once-seeded tenant silently rotted to validate-org-license:false
    // ~14 days later. ACTIVE/free_byok has no such clock.
    if (tenant.license === "community-byok" || tenant.license === "paid") {
        // The cloud gate (libs/ee/shared/services/permissionValidation
        // .service.ts) requires `validation.valid===true` AND
        // `planType` containing "byok" AND a stored BYOK config. The
        // only HTTP path to that end-state (without Stripe Checkout)
        // is the same three-step dance the UI does:
        //   1. POST /billing/trial         → creates the license row
        //   2. configure BYOK in org params
        //   3. POST /billing/migrate-to-free → flips planType to free_byok
        //      (and subscriptionStatus to ACTIVE → no trial expiry)
        // /migrate-to-free fails with "Licença não encontrada" if step 1
        // didn't run first — the endpoint mutates an existing row.
        const trial = await http(
            `${target.webBaseUrl}/api/proxy/billing/trial`,
            {
                method: "POST",
                headers: { Authorization: `Bearer ${session.accessToken}` },
                body: {
                    organizationId: session.organizationId,
                    teamId: session.teamId,
                    byok: true,
                },
                timeoutMs: 30_000,
            },
        );
        const trialOk =
            (trial.status >= 200 && trial.status < 300) ||
            trial.status === 409 ||
            (trial.status === 400 &&
                /already|trial|existe/i.test(
                    (trial.body as any)?.error ??
                        (trial.body as any)?.message ??
                        "",
                ));
        if (!trialOk) {
            console.log(
                `  [warn] ${tenant.license}: trial step returned HTTP ${trial.status}: ${trial.raw.slice(0, 200)}`,
            );
            return false;
        }
        const byokOk = await configureByok(target, session);
        if (!byokOk) return false;
        const migrate = await http(
            `${target.webBaseUrl}/api/proxy/billing/migrate-to-free`,
            {
                method: "POST",
                headers: { Authorization: `Bearer ${session.accessToken}` },
                body: {
                    organizationId: session.organizationId,
                    teamId: session.teamId,
                },
                timeoutMs: 30_000,
            },
        );
        if (migrate.status >= 200 && migrate.status < 300) return true;
        // Already on free_byok → 409 / "already" — treat as success.
        if (
            migrate.status === 409 ||
            /already|free_byok/i.test(
                (migrate.body as any)?.error ??
                    (migrate.body as any)?.message ??
                    "",
            )
        ) {
            return true;
        }
        console.log(
            `  [warn] ${tenant.license}: migrate-to-free returned HTTP ${migrate.status}: ${migrate.raw.slice(0, 200)}`,
        );
        return false;
    }
    const resp = await http(`${target.webBaseUrl}/api/proxy/billing/trial`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.accessToken}` },
        body: {
            organizationId: session.organizationId,
            teamId: session.teamId,
            byok: false,
        },
        timeoutMs: 30_000,
    });
    if (
        resp.status >= 200 &&
        resp.status < 300 &&
        (resp.body as any)?.subscriptionStatus === "trial"
    ) {
        return true;
    }
    // 409 / "already exists" is idempotent OK — billing service refuses
    // to start a second trial for the same team, but the desired end-
    // state (a valid subscription record) is satisfied.
    if (
        resp.status === 409 ||
        (resp.status === 400 &&
            /already|trial|existe/i.test((resp.body as any)?.error ??
                (resp.body as any)?.message ??
                ""))
    ) {
        return true;
    }
    console.log(
        `  [warn] license activation returned HTTP ${resp.status}: ${resp.raw.slice(0, 200)}`,
    );
    return false;
}

// Configures the org's "main" BYOK key by POSTing the same payload the
// UI sends (apps/web/src/features/ee/byok/_components/page.client.tsx).
// Uses the same `API_OPEN_AI_API_KEY` env that drives self-hosted
// installs — by default the team's Moonshot/Kimi K2.6 key with the
// Moonshot base URL. Falls back to native OpenAI defaults if the env
// is unset, which would fail-loud during the first review attempt
// instead of silently scoring this scenario as "BYOK configured" when
// no real key is reachable.
async function configureByok(
    target: TargetContext,
    session: KodusSession,
): Promise<boolean> {
    const apiKey = process.env.API_OPEN_AI_API_KEY;
    if (!apiKey) {
        console.log(
            "  [warn] community-byok skipped: API_OPEN_AI_API_KEY not set in env. " +
                "Configure it in ~/.kodus-dev/config or scripts/e2e/.env before running.",
        );
        return false;
    }
    const provider = process.env.API_LLM_PROVIDER ?? "openai";
    const baseURL =
        process.env.API_OPENAI_FORCE_BASE_URL ?? "https://api.openai.com/v1";
    const model = process.env.API_LLM_PROVIDER_MODEL ?? "gpt-5.4-mini";

    const resp = await http(
        `${target.apiBaseUrl}/organization-parameters/create-or-update`,
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${session.accessToken}`,
                "Content-Type": "application/json",
            },
            body: {
                key: "byok_config",
                configValue: {
                    main: { provider, apiKey, baseURL, model },
                },
            },
            timeoutMs: 30_000,
        },
    );
    if (resp.status >= 200 && resp.status < 300) return true;
    console.log(
        `  [warn] BYOK setup returned HTTP ${resp.status}: ${resp.raw.slice(0, 200)}`,
    );
    return false;
}

async function connectProvider(
    target: TargetContext,
    session: KodusSession,
    tenant: TenantSpec,
): Promise<{
    integrationConnected: boolean;
    repoRegistered: boolean;
    onboardingFinished: boolean;
}> {
    // Provider PATs come from the same env vars the self-hosted matrix
    // uses (GH_TEST_TOKEN / GL_*, BB_*, AZ_TEST_ORG/PROJECT/REPO).
    //
    // Repo addressing: GitHub PAT tenants pin their OWN repo via
    // `tenant.repoFullName` (1 org : 1 repo — see the registry comment),
    // forwarded as makeProvider's repoOverride. The other providers
    // ignore the override and resolve their cloud repo from env
    // (GL_TEST_REPO_CLOUD etc.) — they're already 1 org : 1 repo on
    // cloud. NB: an earlier attempt to overwrite `AZ_TEST_REPO` with the
    // full `<org>/<project>/<repo>` path broke Azure (it composes the URL
    // from three separate env pieces), which is exactly why the override
    // is scoped to GitHub only and the others keep reading env.
    const provider = makeProvider(
        tenant.provider,
        "cloud",
        tenant.repoFullName,
    );
    await registerIntegration(target, provider, session);
    // Wait for /code-management/auth-integration's async post-processing
    // to land before /repositories queries depend on it. The UI flow
    // takes 8-33s between these steps; our HTTP script ran them in
    // ~2s on QA cloud and hit a race at
    // active-code-review-automation.use-case.ts:43 where
    // `const [teamAutomation] = teamAutomationService.find(...)`
    // returned null on empty (Mongo log evidence: single 30d
    // occurrence, only when gap < 8s).
    //
    // 10s clears the race for most tenants but not all — observed one
    // miss on a brand-new community-byok signup. Retry the
    // /code-management/repositories call when it fails specifically
    // with the "(intermediate value) is not iterable" symptom: the
    // server-side post-processing eventually finishes and the next
    // attempt succeeds.
    await new Promise((r) => setTimeout(r, 10_000));
    let repo: Awaited<ReturnType<typeof registerRepo>>;
    try {
        repo = await registerRepo(target, provider, session);
    } catch (err) {
        const message = (err as Error).message ?? String(err);
        if (/is not iterable/.test(message)) {
            console.log(
                "  [info] /repositories hit the post-integration race ('not iterable'); waiting 15s and retrying once",
            );
            await new Promise((r) => setTimeout(r, 15_000));
            repo = await registerRepo(target, provider, session);
        } else {
            throw err;
        }
    }
    // finish-onboarding triggers generateKodyRulesUseCase, which can
    // run >60s — enough for QA's nginx gateway to time out with 504
    // even though the server-side work keeps going to completion. Treat
    // the 504 as soft success: the request landed, the LLM step will
    // finish in the background, and a re-run of finishOnboarding here
    // would re-trigger the same long-running work and time out again.
    let onboardingFinished = true;
    try {
        await finishOnboarding(target, session, repo);
    } catch (err) {
        const message = (err as Error).message ?? String(err);
        if (/HTTP 504/.test(message)) {
            console.log(
                `  [info] finish-onboarding returned 504 (nginx gateway timeout); the server-side rule generation continues asynchronously — treating as completed`,
            );
            onboardingFinished = false;
        } else {
            throw err;
        }
    }
    return {
        integrationConnected: true,
        repoRegistered: true,
        onboardingFinished,
    };
}

async function seedTenant(
    tenant: TenantSpec,
    existing: SavedTenant | undefined,
): Promise<SavedTenant> {
    const target = targetForCloud();
    const password = SHARED_PASSWORD;

    await signUp(target, {
        email: tenant.email,
        password,
        name: tenant.name,
    });

    const session = await login(target, { email: tenant.email, password });

    // github-app tenants skip the PAT-based connectProvider — the
    // scenario itself calls /code-management/auth-integration with
    // authMode=oauth + code=installation_id, which uses a payload
    // shape (no `token` field, repo discovery via App permissions)
    // that the seeder's PAT-shaped registerIntegration doesn't
    // produce. Running it here would either fail or leave a stale
    // PAT integration on the org that the scenario's OAuth upsert
    // would then overwrite — easier to just defer the whole thing.
    let integrationConnected = false;
    let repoRegistered = false;
    let onboardingFinished = false;
    if (tenant.provider === "github-app") {
        console.log(
            `  [info] skipping PAT connectProvider for github-app tenant — scenario will connect via OAuth at runtime`,
        );
    } else {
        const result = await connectProvider(target, session, tenant);
        integrationConnected = result.integrationConnected;
        repoRegistered = result.repoRegistered;
        onboardingFinished = result.onboardingFinished;
    }

    const tierUpgraded = await ensureLicenseTier(target, session, tenant);

    // Order matters: spread `existing` FIRST so the freshly computed
    // values override the stored ones (previously these were spread
    // in the opposite order and `tierUpgraded: true` got silently
    // clobbered by a stale `tierUpgraded: false` from an earlier run).
    return {
        ...(existing ?? {}),
        ...tenant,
        password,
        organizationId: session.organizationId,
        teamId: session.teamId,
        integrationConnected,
        repoRegistered,
        onboardingFinished,
        tierUpgraded,
        seededAt: new Date().toISOString(),
    };
}

async function main(): Promise<void> {
    const saved = readSavedCreds();
    const onlyEmails = (process.env.CLOUD_SETUP_ONLY ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const todo = onlyEmails.length
        ? TENANTS.filter((t) => onlyEmails.includes(t.email))
        : TENANTS;
    if (onlyEmails.length && todo.length === 0) {
        console.error(
            `[cloud-setup] CLOUD_SETUP_ONLY=${onlyEmails.join(",")} matched no tenants in the registry`,
        );
        process.exit(2);
    }

    console.log(`[cloud-setup] target: ${QA_API_BASE_URL}`);
    console.log(
        `[cloud-setup] tenants to seed: ${todo.length}${onlyEmails.length ? " (filtered)" : ""}`,
    );
    console.log(
        `[cloud-setup] creds file: ${CREDS_FILE} (${saved.length} existing entries)`,
    );

    const failures: Array<{ email: string; error: string }> = [];

    let current = saved;
    for (const tenant of todo) {
        console.log(
            `\n[cloud-setup] ▶ ${tenant.email} (${tenant.license} × ${tenant.provider})`,
        );
        const existing = current.find((c) => c.email === tenant.email);
        try {
            const next = await seedTenant(tenant, existing);
            current = upsertCreds(current, next);
            writeSavedCreds(current);
            console.log(`  ✓ saved (org=${next.organizationId}, team=${next.teamId})`);
        } catch (err) {
            const message = (err as Error).message ?? String(err);
            console.error(`  ✗ failed: ${message}`);
            failures.push({ email: tenant.email, error: message });
        }
    }

    console.log(
        `\n[cloud-setup] done. ${todo.length - failures.length}/${todo.length} ok`,
    );
    if (failures.length) {
        for (const f of failures) {
            console.error(`  ✗ ${f.email}: ${f.error}`);
        }
        process.exit(1);
    }
}

main().catch((err) => {
    console.error("[cloud-setup] failed:", err);
    process.exit(1);
});

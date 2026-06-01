/* eslint-disable no-console */
/**
 * Seeds the persistent E2E tenants on the QA cloud (qa.web.kodus.io)
 * that the cloud matrix smoke runs against. Each tenant is
 * single-provider and single-tier so it mirrors the self-hosted
 * isolation pattern.
 *
 * Usage:
 *   yarn cloud:setup-tenants                    # all tenants
 *   CLOUD_SETUP_ONLY=e2e-paid-gh@kodus.io \     # one tenant
 *     yarn cloud:setup-tenants
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
import type {
    KodusSession,
    ProviderName,
    TargetContext,
} from "../../lib/types.js";

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

type TenantLicense = "paid" | "trial" | "free" | "community-byok";

interface TenantSpec {
    email: string;
    name: string;
    license: TenantLicense;
    provider: ProviderName;
    repoFullName: string;
}

// Tenant registry. Names can only contain letters / spaces / hyphens /
// apostrophes (Kodus validates `^[A-Za-z\s\-']+$` server-side), so no
// digits in the visible name.
//
// Repos are shared across tiers of the same provider — license tier is
// per-org on cloud (Stripe-driven), so each tier needs its own
// organization, but webhooks from a single repo can be disambiguated
// by Kodus per integration (App installation id for GitHub, OAuth/PAT
// integration uuid for GitLab/Bitbucket/Azure). One downside: the
// `generateKodyRulesUseCase` step at finish-onboarding reads the
// repo's PR history regardless of which org is onboarding, so the
// rules generated for tier B can be shaped by traffic from tier A —
// acceptable for the QA matrix where the license-attribution and
// per-seat gates are the real signal; revisit if a scenario needs
// strictly isolated rule histories.
const TENANTS: TenantSpec[] = [
    {
        email: "e2e-paid-gh@kodus.io",
        name: "Smoke Paid GitHub",
        license: "paid",
        provider: "github",
        repoFullName: "kodus-e2e/tiny-url",
    },
    {
        email: "e2e-free-gh@kodus.io",
        name: "Smoke Free GitHub",
        license: "free",
        provider: "github",
        repoFullName: "kodus-e2e/tiny-url",
    },
    {
        email: "e2e-trial-gh@kodus.io",
        name: "Smoke Trial GitHub",
        license: "trial",
        provider: "github",
        repoFullName: "kodus-e2e/tiny-url",
    },
    {
        email: "e2e-paid-gl@kodus.io",
        name: "Smoke Paid GitLab",
        license: "paid",
        provider: "gitlab",
        repoFullName: "kodus-e2e/tiny-url",
    },
    {
        email: "e2e-paid-bb@kodus.io",
        name: "Smoke Paid Bitbucket",
        license: "paid",
        provider: "bitbucket",
        repoFullName: "kodustech/tiny-url",
    },
    {
        email: "e2e-paid-az@kodus.io",
        name: "Smoke Paid Azure",
        license: "paid",
        provider: "azure-devops",
        repoFullName: "kodustech/kodus-e2e/tiny-url",
    },
    {
        // Community tenant: NO billing subscription, but with BYOK
        // configured. Reviews work with the 10-rule limit. Distinct
        // from `free` (trial expired + no BYOK = gate blocks).
        email: "e2e-community-byok-gh@kodus.io",
        name: "Smoke Community BYOK GitHub",
        license: "community-byok",
        provider: "github",
        repoFullName: "kodus-e2e/tiny-url",
    },
    {
        // Stripe billing scenario — sub-flow #1 (free → paid via
        // Checkout) and then sub-flow #3 (cancel via Customer Portal
        // once paid). Seeded as `free` so the scenario can drive the
        // first Checkout completion itself; the cancel step runs
        // inside the same scenario after the upgrade lands. Re-runs
        // are idempotent: if the tenant ends up cancelled, the next
        // run starts with the cancel state and exercises the upgrade
        // path again.
        email: "e2e-stripe-checkout-free@kodus.io",
        name: "Stripe Checkout Free GitHub",
        license: "free",
        provider: "github",
        repoFullName: "kodus-e2e/tiny-url",
    },
    {
        // Stripe billing scenario — sub-flow #2 (trial → paid via
        // Checkout) and then sub-flow #4 (downgrade paid → free via
        // /billing/migrate-to-free). Seeded as `trial` so the
        // /billing/trial call lands a fresh subscription record the
        // Checkout flow can upgrade.
        email: "e2e-stripe-checkout-trial@kodus.io",
        name: "Stripe Checkout Trial GitHub",
        license: "trial",
        provider: "github",
        repoFullName: "kodus-e2e/tiny-url",
    },
    {
        // GitHub App (OAuth installation) variant. Needs a DEDICATED
        // tenant — sharing one with the PAT cells would have the App
        // and the PAT both registered against the same Kodus
        // organization, which makes the auth-integration upsert
        // overwrite one with the other on each run. The repo
        // (kodus-e2e/tiny-url-app) is the scope-limited install
        // target of the kodus-ai-qa GitHub App; the App's webhook
        // delivers to qa.web.kodus.io. Connect step is SKIPPED at
        // seed time (provider==="github-app") because the scenario
        // itself calls /code-management/auth-integration with
        // authMode=oauth + code=installation_id, which has a
        // different payload than the PAT path used by the seeder.
        email: "e2e-paid-gh-app@kodus.io",
        name: "Smoke Paid GitHub App",
        license: "paid",
        provider: "github-app",
        repoFullName: "kodus-e2e/tiny-url-app",
    },
];

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
//   - `trial` / `paid`  → activate the trial billing record via
//                          `POST /api/proxy/billing/trial`. Real
//                          paid would need Stripe Checkout but for
//                          the matrix's gate-allows assertion trial
//                          is sufficient. TODO: hook up the Stripe
//                          flow when we need to differentiate paid-
//                          specific limits.
async function ensureLicenseTier(
    target: TargetContext,
    session: KodusSession,
    tenant: TenantSpec,
): Promise<boolean> {
    if (tenant.license === "free") return true;
    if (tenant.license === "community-byok") {
        // The cloud gate (libs/ee/shared/services/permissionValidation
        // .service.ts) requires `validation.valid===true` AND
        // `planType` containing "byok" AND a stored BYOK config. The
        // only HTTP path to that end-state (without Stripe Checkout)
        // is the same three-step dance the UI does:
        //   1. POST /billing/trial         → creates the license row
        //   2. configure BYOK in org params
        //   3. POST /billing/migrate-to-free → flips planType to free_byok
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
                `  [warn] community-byok: trial step returned HTTP ${trial.status}: ${trial.raw.slice(0, 200)}`,
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
            `  [warn] community-byok: migrate-to-free returned HTTP ${migrate.status}: ${migrate.raw.slice(0, 200)}`,
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
    const model = process.env.API_LLM_PROVIDER_MODEL ?? "kimi-k2.6";

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
    // Provider PATs + repo addressing come from the same env vars the
    // self-hosted matrix uses (GH_TEST_TOKEN / GH_TEST_REPO / GL_*,
    // BB_*, AZ_TEST_ORG/PROJECT/REPO). All cloud tenants point at the
    // same fixture repos as self-hosted — there's nothing per-tenant
    // to override here. The earlier attempt to overwrite e.g.
    // `AZ_TEST_REPO` with the full `<org>/<project>/<repo>` path broke
    // the Azure provider because it composes the URL from the three
    // separate env pieces and the merged string isn't a valid repo
    // name. Leave env alone.
    // Cloud tenant seeding uses the cloud-target repo so onboarding registers
    // the same `*-cloud` fixture repo the cloud cells open PRs against.
    const provider = makeProvider(tenant.provider, "cloud");
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

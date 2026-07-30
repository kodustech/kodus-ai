import type { ProviderName } from "./types.js";

// Canonical registry of the persistent QA-cloud E2E tenants. Lives in lib/
// (not cli/cloud/setup-tenants.ts) because TWO consumers must agree on it:
//
//   1. cli/cloud/setup-tenants.ts seeds the tenants and persists creds to
//      ~/.kodus-dev/cloud-tenants.json (mirrored into the CLOUD_TENANTS_JSON
//      secret for CI).
//   2. lib/runner.ts resolves the per-cell tenant from that file — and falls
//      back to THIS registry for `repoFullName` when the file entry lacks it.
//
// Consumer 2 is the hard-won lesson: on 2026-06-03 the cloud-matrix job
// gained `environment: QA`, whose stale environment-scoped copy of
// CLOUD_TENANTS_JSON (sealed 05-30, before the 1-repo-per-tenant fix in
// #1237) silently shadowed the fresh repo-level secret. Every GitHub tenant
// fell back to the shared kodus-e2e/tiny-url-cloud repo and the webhook
// fan-out collision came right back ("review never started" flakes). With
// the repo mapping ALSO in code, a stale secret can no longer reintroduce
// the collision — the secret only carries credentials/org ids.

export type TenantLicense = "paid" | "trial" | "free" | "community-byok";

export interface TenantSpec {
    email: string;
    name: string;
    license: TenantLicense;
    provider: ProviderName;
    // Dedicated cloud fixture repo for this tenant. REQUIRED for GitHub
    // PAT tenants and honoured only there (makeProvider forwards it to
    // the GitHub provider via repoOverride; the other providers resolve
    // their cloud repo from env). Optional for the rest.
    repoFullName?: string;
}

// Tenant registry. Names can only contain letters / spaces / hyphens /
// apostrophes (Kodus validates `^[A-Za-z\s\-']+$` server-side), so no
// digits in the visible name.
//
// GitHub PAT tenants get ONE REPO EACH (1 org : 1 repo). License tier is
// per-org on cloud (Stripe-driven), so every tier is a distinct Kodus
// org. The PAT webhook is a bare `/github/webhook` with no per-org
// discriminator, and the backend resolves repo→org by picking the first
// IntegrationConfig ordered by updatedAt DESC (webhook-context.service
// .getContext / save.use-case). So if several orgs share one repo, a
// PR's review fires for whichever org most recently touched its repo
// config — NOT reliably the org under test — and the scenario times out
// waiting for a review that landed on someone else (or got silently
// dropped). Giving each tenant its own repo removes the ambiguity
// entirely, matching what GitLab/Bitbucket/Azure already get for free
// (one org per repo on cloud). github-app is already isolated on its
// App-bound repo. Provision the repos with scripts/e2e/provision-cloud-
// github-repos.sh before the first seed.
export const CLOUD_TENANTS: TenantSpec[] = [
    {
        email: "e2e-paid-gh@kodus.io",
        name: "Smoke Paid GitHub",
        license: "paid",
        provider: "github",
        repoFullName: "kodus-e2e/tiny-url-cloud-paid",
    },
    {
        email: "e2e-free-gh@kodus.io",
        name: "Smoke Free GitHub",
        license: "free",
        provider: "github",
        repoFullName: "kodus-e2e/tiny-url-cloud-free",
    },
    {
        email: "e2e-trial-gh@kodus.io",
        name: "Smoke Trial GitHub",
        license: "trial",
        provider: "github",
        repoFullName: "kodus-e2e/tiny-url-cloud-trial",
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
        repoFullName: "kodus-e2e/tiny-url-cloud-community",
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
        repoFullName: "kodus-e2e/tiny-url-cloud-stripe-free",
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
        repoFullName: "kodus-e2e/tiny-url-cloud-stripe-trial",
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

// Fail-fast invariant: every GitHub PAT tenant MUST have its own repo,
// and no two may share one. This is the whole point of the 1 org : 1
// repo fix — a regression here (a new github tenant pointed at a sibling's
// repo, or left without `repoFullName`) silently reintroduces the
// webhook fan-out collision. Catch it at load time, loudly, instead of
// as a flaky "review never started" three matrix runs later.
export function validateGithubRepoIsolation(tenants: TenantSpec[]): void {
    const seen = new Map<string, string>();
    const problems: string[] = [];
    for (const t of tenants) {
        if (t.provider !== "github") continue; // github-app + others are already isolated
        if (!t.repoFullName) {
            problems.push(`${t.email}: github tenant has no dedicated repoFullName`);
            continue;
        }
        const prior = seen.get(t.repoFullName);
        if (prior) {
            problems.push(
                `${t.repoFullName} is shared by ${prior} and ${t.email} — github tenants must not share a repo`,
            );
        } else {
            seen.set(t.repoFullName, t.email);
        }
    }
    if (problems.length) {
        throw new Error(
            `[cloud-tenants] github repo-isolation invariant violated:\n  - ${problems.join("\n  - ")}`,
        );
    }
}
validateGithubRepoIsolation(CLOUD_TENANTS);

/** Canonical fixture repo for a (provider, license) cloud tenant, or
 *  undefined when the registry has no such tenant / no pinned repo. */
export function registryRepoFor(
    provider: ProviderName,
    license: string,
): string | undefined {
    return CLOUD_TENANTS.find(
        (t) => t.provider === provider && t.license === license,
    )?.repoFullName;
}

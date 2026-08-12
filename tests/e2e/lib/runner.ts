import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
    LicenseMode,
    MatrixCell,
    ProviderName,
    Scenario,
    ScenarioResult,
    ScenarioStatus,
    KodusSession,
    SkipKind,
    Target,
    TargetContext,
    TenantCredentials,
} from "./types.js";
import { ScenarioSkipError } from "./types.js";
import { makeProvider } from "../providers/index.js";
import {
    makeGithubTokenPicker,
    preflightGithubRateLimits,
    preflightIntegrationToken,
    integrationQuota,
} from "./github-token-pool.js";
import type { RateLimitInfo } from "./github-token-pool.js";
import {
    IDLE,
    describeQuotaCurve,
    startQuotaSampler,
} from "./quota-curve.js";
import { githubAppToken } from "./github-app-token.js";
import {
    finishOnboarding,
    login,
    registerIntegration,
    registerRepo,
    signUp,
} from './onboarding.js';
import { randomBytes } from 'node:crypto';
import { http } from './http.js';
import { settle } from '../providers/base.js';
import { registryRepoFor } from './cloud-tenant-registry.js';
import { logger } from './log.js';
import { collectServerEvidence, isTargetReachable } from './server-evidence.js';

const log = logger('runner');

export interface RunOptions {
    artifactRoot: string;
    runId: string;
    target: Target;
    cells: MatrixCell[];
    scenarios: Scenario[];
    failFast?: boolean;
    dryRun?: boolean;
}

export interface RunOutcome {
    runId: string;
    startedAt: string;
    finishedAt: string;
    results: ScenarioResult[];
}

export function appliesToCell(
    scenario: Scenario,
    cell: MatrixCell,
): boolean {
    // A cell may pin itself to a subset of scenarios (canary cells — see
    // MatrixCell.only). Checked first: it narrows, never widens, so a scenario
    // whose appliesTo excludes the cell still cannot run here.
    if (cell.only && !cell.only.includes(scenario.id)) return false;
    const at = scenario.appliesTo;
    if (at.target && !at.target.includes(cell.target)) return false;
    if (at.provider && !at.provider.includes(cell.provider)) return false;
    if (at.license && !at.license.includes(cell.license)) return false;
    return true;
}

// Per-provider env-var suffix: uppercase, non-alnum → `_`.
// github → GITHUB, azure-devops → AZURE_DEVOPS, github-app → GITHUB_APP.
// Used so each self-hosted provider can point at its OWN droplet via
// SELFHOSTED_API_BASE_URL_<SUFFIX> (set by --auto-provision-per-provider),
// enabling the per-provider parallel matrix. Falls back to the shared
// SELFHOSTED_* vars for the single-droplet (serial) path.
export function selfhostedEnvSuffix(provider: ProviderName): string {
    return provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function envForTarget(target: Target, provider?: ProviderName): TargetContext {
    if (target === 'cloud') {
        // QA cloud routes API traffic through the web app's reverse proxy
        // at `/api/proxy/api/*` — the standalone `api-qa.kodus.io` host is
        // an internal name not reachable from external machines. Default
        // to `qa.web.kodus.io` (the same URL `setup-tenants.ts` uses) so
        // the matrix runner and the seeder hit the same backend.
        //
        // Cloud DELIBERATELY does NOT honour TARGET_BASE_URL — that env
        // is used by --auto-provision to broadcast the self-hosted
        // droplet's API URL, and reading it here for the cloud target
        // would point cloud cells at the self-hosted droplet (observed
        // 2026-05-20: HTTP 401 on cloud login because the droplet's
        // API doesn't know the cloud tenant). Cloud uses
        // CLOUD_API_BASE_URL for overrides and the default otherwise.
        const webBaseUrl =
            process.env.CLOUD_WEB_BASE_URL ?? 'https://qa.web.kodus.io';
        const apiBaseUrl =
            process.env.CLOUD_API_BASE_URL ??
            `${webBaseUrl.replace(/\/$/, '')}/api/proxy/api`;
        return { target, apiBaseUrl, webBaseUrl };
    }
    // Self-hosted resolution order, most specific first:
    //   1. SELFHOSTED_*_<PROVIDER>  — set by --auto-provision-per-provider,
    //      one droplet per provider (enables parallel isolated runs)
    //   2. SELFHOSTED_*             — shared single-droplet auto-provision
    //   3. TARGET_*                 — legacy generic envs (manual runs)
    const sfx = provider ? selfhostedEnvSuffix(provider) : undefined;
    const perProvider = (base: string): string | undefined =>
        sfx ? process.env[`${base}_${sfx}`] : undefined;

    const apiBaseUrl =
        perProvider('SELFHOSTED_API_BASE_URL') ??
        process.env.SELFHOSTED_API_BASE_URL ??
        process.env.TARGET_BASE_URL ??
        (() => {
            throw new Error(
                `SELFHOSTED_API_BASE_URL_${sfx ?? '<PROVIDER>'} or SELFHOSTED_API_BASE_URL or TARGET_BASE_URL is required for self-hosted target (e.g. http://1.2.3.4:3001)`,
            );
        })();
    const webBaseUrl =
        perProvider('SELFHOSTED_WEB_URL') ??
        process.env.SELFHOSTED_WEB_URL ??
        process.env.TARGET_WEB_URL ??
        apiBaseUrl.replace(/:3001$/, ':3000');
    const tunnelUrl =
        perProvider('SELFHOSTED_TUNNEL_URL') ??
        process.env.SELFHOSTED_TUNNEL_URL ??
        process.env.TARGET_TUNNEL_URL;
    if (!tunnelUrl) {
        throw new Error(
            `SELFHOSTED_TUNNEL_URL_${sfx ?? '<PROVIDER>'} or SELFHOSTED_TUNNEL_URL or TARGET_TUNNEL_URL is required for self-hosted target (e.g. https://xxx.trycloudflare.com)`,
        );
    }
    return { target, apiBaseUrl, webBaseUrl, tunnelUrl };
}

// Resolves tenant credentials for a cell.
//
// `cloud`: pre-provisioned tenants per license tier (free/trial/paid)
// because the cloud control plane wires each tier into Stripe and we
// can't reproduce that from the test runner. The env vars are seeded by
// run.sh from `~/.kodus-dev/config` (or 1Password refs).
//
// `self-hosted`: one persistent tenant PER PROVIDER, seeded during
// `provision.sh` so they're the OLDEST tenants on the droplet. Two
// reasons we don't sign up a fresh tenant per cell:
//
//   1. Kodus's `getTypeIntegration` resolves the platform by category
//      alone (not by platform). One tenant with multiple integrations
//      ends up routing dispatches to the first match. Splitting per
//      provider keeps each tenant single-integration.
//
//   2. Webhook routing on Bitbucket has no disambiguator: when several
//      tenants register the same repo, `webhookContextService.getContext`
//      returns the OLDEST tenant with an active code-review automation.
//      A fresh tenant per cell guarantees a stale tenant wins the route
//      and our test's just-created rule never reaches the review
//      pipeline. Persistent provider-scoped tenants — created at
//      provision time, before any test traffic — sidestep both issues.
//
// The shared password matches the default dev user's password so the
// state file (and the `SH_TENANT_PASSWORD` env) stays usable for both.
interface CloudTenantEntry {
    email: string;
    password: string;
    license: LicenseMode;
    provider: ProviderName;
    organizationId?: string;
    teamId?: string;
    // Per-tenant fixture repo persisted by setup-tenants. Drives the
    // provider's repo for this cell so each cloud GitHub tenant runs on
    // its own repo (1 org : 1 repo). Absent for providers that don't
    // need isolation → falls back to the env-resolved per-target repo.
    repoFullName?: string;
}

function readCloudTenantsFile(): CloudTenantEntry[] {
    const path = join(homedir(), '.kodus-dev', 'cloud-tenants.json');
    if (!existsSync(path)) return [];
    try {
        const raw = readFileSync(path, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as CloudTenantEntry[]) : [];
    } catch {
        return [];
    }
}

// Re-apply the CURRENT env LLM key to every registry tenant's byok_config.
// Cloud tenants are seeded once (setup-tenants) and keep their BYOK key in
// the tenant itself, so a key rotation strands them on the revoked key and
// every review dies with `partial_error: Incorrect API key` — which zeroed
// all paid cloud cells after the 2026-07-24 rotation. One login + one POST
// per unique tenant, idempotent (same create-or-update endpoint the seeder
// uses), best-effort per tenant, and skipped when no env key is configured.
/**
 * Write a tenant's BYOK config through the API — the same row the product UI
 * writes, and the same one `resolveKodyRulesModelPolicy` and the review path
 * read FIRST.
 *
 * This is how the e2e states the provider EXPLICITLY. The env path
 * (`API_LLM_PROVIDER_MODEL`) cannot: `describeEnvLLMConfig` infers the provider
 * from the model name and only recognises Gemini and Claude, so every OpenAI
 * model routes as `openai_compatible`. Harmless for gpt-5.4-mini, fatal for a
 * reasoning model — `Function tools with reasoning_effort are not supported for
 * gpt-5.6-luna in /v1/chat/completions` — which is a real self-hosted bug, but
 * one the harness should not be blocked on.
 *
 * Writing the DB config takes the same route a customer takes, so the test
 * exercises the supported path instead of the inferred one.
 */
async function applyByokToTenant(
    target: TargetContext,
    session: KodusSession,
): Promise<{ ok: boolean; status: number }> {
    const resp = await http(
        `${target.apiBaseUrl}/organization-parameters/create-or-update`,
        {
            method: 'POST',
            headers: { Authorization: `Bearer ${session.accessToken}` },
            body: {
                key: 'byok_config',
                configValue: { main: byokFromEnv() },
            },
            timeoutMs: 30_000,
        },
    );
    return { ok: resp.status >= 200 && resp.status < 300, status: resp.status };
}

/**
 * The BYOK block the matrix wants every tenant to use. `API_LLM_PROVIDER`
 * defaults to `openai`; point it (with `API_OPENAI_FORCE_BASE_URL`) at any
 * OpenAI- or Anthropic-compatible vendor to run the matrix on a different
 * model without touching the product.
 */
function byokFromEnv(): {
    provider: string;
    apiKey: string;
    baseURL: string;
    model: string;
} {
    return {
        provider: process.env.API_LLM_PROVIDER ?? 'openai',
        apiKey: process.env.API_OPEN_AI_API_KEY ?? '',
        baseURL:
            process.env.API_OPENAI_FORCE_BASE_URL ??
            'https://api.openai.com/v1',
        model: process.env.API_LLM_PROVIDER_MODEL ?? 'gpt-5.4-mini',
    };
}

async function refreshCloudTenantByok(log: {
    info: (m: string) => void;
    warn: (m: string) => void;
}): Promise<void> {
    const apiKey = process.env.API_OPEN_AI_API_KEY;
    if (!apiKey) {
        log.info(
            '[byok-refresh] API_OPEN_AI_API_KEY unset — tenants keep their seeded BYOK key',
        );
        return;
    }
    const entries = readCloudTenantsFile();
    if (!entries.length) return;

    const target = envForTarget('cloud');
    const provider = process.env.API_LLM_PROVIDER ?? 'openai';
    const baseURL =
        process.env.API_OPENAI_FORCE_BASE_URL ?? 'https://api.openai.com/v1';
    const model = process.env.API_LLM_PROVIDER_MODEL ?? 'gpt-5.4-mini';

    // The `free` tenant is DEFINED by not having a key of its own: that is what
    // makes it a free tenant rather than a community-plan one, and
    // license-attribution asserts it receives no review. Writing byok_config
    // onto it turns it into exactly the tenant the registry already keeps
    // separately as `community-byok`, and the product then reviews its PRs --
    // correctly. The test was refuting an entitlement rule it had just spent
    // the run start dismantling (observed live, cloud run 31601925282).
    const seen = new Set<string>();
    for (const entry of entries) {
        if (entry.license === 'free') {
            // Skipping the write is not enough: the key persists on the tenant
            // from every run before this one, so the free tenant stays a
            // community tenant forever and license-attribution keeps failing
            // (observed on cloud runs 31601925282 and 31608293474 -- the second
            // one WITH the skip in place). Its identity has to be ENFORCED each
            // run, not assumed.
            try {
                const session = await login(target, {
                    email: entry.email,
                    password: entry.password,
                });
                const resp = await http(
                    `${target.apiBaseUrl}/organization-parameters/delete-byok-config?configType=main`,
                    {
                        method: 'DELETE',
                        headers: {
                            Authorization: `Bearer ${session.accessToken}`,
                        },
                        timeoutMs: 30_000,
                    },
                );
                // 2xx cleared something; 400/404 means there was nothing to
                // clear, which is the state we want and not a failure. Saying
                // "CLEARED" on a 400 was a line that lied about its own
                // result -- the exact habit this matrix spent the day
                // removing from everywhere else.
                if (resp.status >= 200 && resp.status < 300) {
                    log.info(
                        `[byok-refresh] ${entry.provider}/free: byok_config CLEARED — a free tenant is defined by having no key of its own`,
                    );
                } else if (resp.status === 400 || resp.status === 404) {
                    log.info(
                        `[byok-refresh] ${entry.provider}/free: no byok_config to clear (HTTP ${resp.status}) — already in the state a free tenant should be in`,
                    );
                } else {
                    log.warn(
                        `[byok-refresh] ${entry.provider}/free: clearing byok_config returned HTTP ${resp.status} — license-attribution will fail if a key is still stored`,
                    );
                }
            } catch (err) {
                log.warn(
                    `[byok-refresh] ${entry.provider}/free: could not clear byok_config (${(err as Error).message.slice(0, 120)}) — license-attribution will fail if a key is still stored`,
                );
            }
            continue;
        }
        if (seen.has(entry.email)) continue;
        seen.add(entry.email);
        try {
            const session = await login(target, {
                email: entry.email,
                password: entry.password,
            });
            const resp = await applyByokToTenant(target, session);
            if (resp.ok) {
                log.info(
                    `[byok-refresh] ${entry.provider}/${entry.license}: byok_config updated`,
                );
            } else {
                log.warn(
                    `[byok-refresh] ${entry.provider}/${entry.license}: HTTP ${resp.status} — tenant keeps its stored key`,
                );
            }
        } catch (err) {
            log.warn(
                `[byok-refresh] ${entry.provider}/${entry.license}: ${(err as Error).message.slice(0, 120)} — continuing`,
            );
        }
    }
}

// Per-tenant fixture repo for a cloud cell. Prefers what the tenants file
// (CLOUD_TENANTS_JSON in CI) says, but falls back to the canonical
// lib/cloud-tenant-registry.ts mapping when the entry predates the
// 1-repo-per-tenant fix (#1237) and lacks `repoFullName`. Without the
// fallback, a stale secret silently drops every GitHub tenant onto the
// shared env-resolved repo (GH_TEST_REPO_CLOUD) and the webhook fan-out
// collision returns as "review never started" flakes — exactly what
// happened 2026-06-03 when `environment: QA` started shadowing the fresh
// repo-level secret with a 05-30 environment-scoped copy. For GitHub the
// repo is load-bearing (1 org : 1 repo), so having NEITHER source is a
// hard config error, not a quiet fallback.
function resolveCloudRepo(
    fromTenantsFile: string | undefined,
    provider: ProviderName,
    license: LicenseMode,
): string | undefined {
    if (fromTenantsFile) return fromTenantsFile;
    const fromRegistry = registryRepoFor(provider, license);
    if (provider !== 'github') return fromRegistry;
    if (!fromRegistry) {
        throw new Error(
            `cloud github tenant (license=${license}) has no dedicated fixture repo: ` +
                `the tenants file entry lacks repoFullName AND lib/cloud-tenant-registry.ts ` +
                `has no (github, ${license}) tenant. Re-seed with \`yarn cloud:setup-tenants\` ` +
                `or add the tenant to the registry — falling back to a shared repo would ` +
                `reintroduce the webhook fan-out collision (#1237).`,
        );
    }
    log.info(
        `[tenant] cloud-tenants entry for (github, ${license}) lacks repoFullName ` +
            `(stale CLOUD_TENANTS_JSON / cloud-tenants.json) — using registry default ${fromRegistry}. ` +
            `Re-seed with \`yarn cloud:setup-tenants\` and refresh the secret.`,
    );
    return fromRegistry;
}

async function resolveTenantForCell(
    target: TargetContext,
    license: LicenseMode,
    provider: ProviderName,
    runId: string,
): Promise<TenantCredentials | undefined> {
    if (target.target === 'cloud') {
        // Preferred path (post-cloud:setup-tenants): match by
        // (provider, license) in ~/.kodus-dev/cloud-tenants.json. Each
        // entry has email + password + the resolved org/team uuids the
        // setup phase persisted.
        const entries = readCloudTenantsFile();
        const match = entries.find(
            (e) => e.provider === provider && e.license === license,
        );
        if (match)
            return {
                email: match.email,
                password: match.password,
                repoFullName: resolveCloudRepo(
                    match.repoFullName,
                    provider,
                    license,
                ),
            };

        // Legacy fallback: per-license env vars (CLOUD_TENANT_PAID_EMAIL
        // etc.). Kept so a one-off run can drive a hand-seeded tenant
        // without touching the JSON file.
        const map: Record<string, [string, string] | undefined> = {
            free: ['CLOUD_TENANT_FREE_EMAIL', 'CLOUD_TENANT_FREE_PASSWORD'],
            trial: ['CLOUD_TENANT_TRIAL_EMAIL', 'CLOUD_TENANT_TRIAL_PASSWORD'],
            paid: ['CLOUD_TENANT_PAID_EMAIL', 'CLOUD_TENANT_PAID_PASSWORD'],
        };
        const key = map[license];
        if (!key) return undefined;
        const email = process.env[key[0]];
        const password = process.env[key[1]];
        if (!email || !password) return undefined;
        return {
            email,
            password,
            repoFullName: resolveCloudRepo(undefined, provider, license),
        };
    }
    // self-hosted: fresh tenant per matrix run. Deterministic per
    // (runId, provider) so all cells/scenarios within ONE matrix run
    // share state (cell 1 onboarding-webhook prepares config that
    // cell 2 code-review-basic relies on), but a new run starts from
    // a clean tenant — no carryover of stale code_review_config rows,
    // command-review's automatedReviewActive=false leftover, or a
    // team_automation that drifted out of sync after dozens of
    // POST /parameters/create-or-update calls. Junior 2026-05-21:
    // the deterministic `e2e-${provider}@kodus.local` email accumu-
    // lated 25 rows of code_review_config from earlier debug runs and
    // the latest row's `configs: { automatedReviewActive: false }`
    // (left behind by command-review's finally restoration, which
    // is a known no-op due to deepDifference stripping the default
    // value) silently skipped the review pipeline on subsequent
    // cells — fresh, uncluttered tenants dodge the whole class.
    //
    // SH_TENANT_EMAIL override remains for one-off manual runs where
    // the caller deliberately wants a specific persistent tenant.
    const explicitEmail = process.env.SH_TENANT_EMAIL;
    // runId format is `2026-05-22T17-43-13-XXXZ-abcdef`. slice(0,8) =
    // `2026-05-` collides for every run on the same calendar day,
    // which silently reuses a tenant whose code_review_config got
    // polluted by per-seat-toggle (`automatedReviewActive: false`) or
    // kody-rules cleanup deletes in a previous matrix cycle — the
    // review pipeline then short-circuits in ~1s with the job marked
    // COMPLETED and zero `Code Review Started!` comment, which Phase
    // A reports as "pipeline never started". slice(0,16) drops down
    // to per-minute granularity, so two back-to-back runs in the same
    // minute still collide intentionally (useful for reruns within
    // 60s); cross-minute runs always get fresh tenants.
    const email =
        explicitEmail ??
        `e2e-${provider}-${runId.slice(0, 16).replace(/[^a-z0-9-]/gi, '')}@kodus.local`;
    const password =
        process.env.SH_TENANT_PASSWORD ??
        process.env.TEST_USER_PASSWORD ??
        `E2eSmoke!${randomBytes(4).toString('hex')}`;
    await signUp(target, { email, password });
    return { email, password };
}

// Failure shapes worth ONE automatic retry: ABSENCE (something expected
// never arrived — lost webhook, review that never materialized, pipeline
// that never woke) and NETWORK/INFRA noise. These are the flake classes
// observed in practice (e.g. kody-rules × gitlab "No review activity on
// PR … within timeout" while the same repo passed 3 other scenarios in
// the same run). Deterministic mismatches — "expected deny, got allow",
// "Kody posted one", wrong subscriptionStatus — deliberately do NOT
// match: re-running cannot change a wrong value, it only burns an LLM
// review and 10 minutes.
// NOTE on the first entry: a BARE /timeout/i used to head this list. It
// matched any message containing the word — including deterministic
// mismatches like "expected timeout config 30, got 60" — so a wrong value
// bought itself a retry and a second LLM review. Transport timeouts are
// already covered by the network shapes below (ETIMEDOUT, "operation was
// aborted"), so the bare word is gone and only the phrasings that actually
// denote a waited-and-nothing-came failure remain.
const TRANSIENT_FAILURE_PATTERNS: RegExp[] = [
    /within \d+\s*s/i,
    /after \d+\s*s/i,
    /within timeout/i,
    /no review activity|none arrived|never arrived|never (reached|registered|woke|started)|did not (arrive|appear|start)/i,
    /HTTP 5\d\d|HTTP 429|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang ?up|network error|Recv failure|operation was aborted|(connection|request|socket) timed ?-?out/i,
];

export function isTransientFailure(message: string): boolean {
    return TRANSIENT_FAILURE_PATTERNS.some((re) => re.test(message ?? ''));
}

// GitHub's primary rate limit is per ACCOUNT and resets hourly, so an
// in-run retry can't clear it — re-running just burns more of the same
// quota. When a cell fails purely because GitHub said "rate limit
// exceeded", we mark it SKIPPED (infra, not a product failure) so a
// transient quota exhaustion doesn't gate a release as red. This is
// reported LOUDLY (log.err + a github-rate-limit skipReason) precisely so
// it can't masquerade as a clean pass — a wall of rate-limit skips means
// "add quota / spread load", not "all green".
const GITHUB_RATE_LIMIT_PATTERN =
    /rate limit exceeded|api rate limit|secondary rate limit|exceeded a secondary rate limit/i;
export function isGithubRateLimit(message: string): boolean {
    return GITHUB_RATE_LIMIT_PATTERN.test(message ?? '');
}

// ABSENCE failures (an expected event never materialized — review never
// started, comment never arrived) get a settle delay before the retry.
// Rationale: the per-deploy matrix starts ~5s after the GitOps infra PR,
// and the version gate only proves the API converged — the WORKERS are
// still rolling when the first review scenario fires its webhook. The
// webhook lands (200), the job dies with the old worker, and an IMMEDIATE
// retry falls inside the same rollout window: run 27021874607 had PRs
// #22+#23 (attempt + instant retry, 15:16–15:19) with zero comments while
// PR #24 one minute later reviewed fine. Two minutes covers the observed
// worker-cycle gap. Pure transport noise (5xx/ECONNRESET/fetch failed)
// keeps the instant retry — waiting buys nothing there.
const ABSENCE_FAILURE_PATTERNS: RegExp[] = [
    /no review activity|none arrived|never arrived|never (reached|registered|woke|started)|did not (arrive|appear|start)/i,
    /No .* (comment|review|status) on (PR|MR)/i,
];

export function absenceRetryDelayMs(message: string): number {
    return ABSENCE_FAILURE_PATTERNS.some((re) => re.test(message ?? ''))
        ? 120_000
        : 0;
}

export async function runMatrix(opts: RunOptions): Promise<RunOutcome> {
    const startedAt = new Date().toISOString();
    const results: ScenarioResult[] = [];
    // Carried ACROSS cells, not per cell: the gap this detects is the time
    // between two scenarios, and cell boundaries are just another gap.
    let lastQuotaAfter: RateLimitInfo | undefined;
    const artifactDir = join(opts.artifactRoot, opts.runId);
    mkdirSync(artifactDir, { recursive: true });

    // Timer-based quota sampling, alongside the per-scenario deltas below.
    // The two answer different questions: the deltas say what a scenario cost,
    // the curve says what was ACTUALLY burning and when. They disagree
    // whenever work is asynchronous -- the onboarding backfill is dispatched
    // in the background, so its spend gets charged to whatever scenario
    // happens to be in the foreground when it lands. See quota-curve.ts.
    const quotaSampler =
        opts.dryRun || !opts.cells.some((c) => c.provider === 'github')
            ? undefined
            : startQuotaSampler({ probe: () => integrationQuota() });

    // Idempotency pre-flight: abandon every PR (or MR) on each
    // fixture repo whose title starts with `[e2e]` and is still
    // open. Per-scenario `closePR()` runs in `finally` and covers
    // the happy path, but a scenario crash, a SIGINT to the runner,
    // or a parallel-cell abort all leave PRs orphaned — the NEXT
    // matrix run then hits HTTP 409 ("an active PR for this branch
    // pair already exists") on Azure, PR-number drift on Bitbucket,
    // or webhook bursts on auto-closed orphans across all providers.
    // Cleaning up here makes every run start from a known-clean
    // state regardless of how the previous one ended. Deduped on
    // (provider, repo): cloud GitHub tenants each own a SEPARATE repo
    // (1 org : 1 repo), so a stale [e2e] PR can hide on a sibling
    // tenant's repo and 409 its next run — visit every distinct repo,
    // not just every provider. `opts.dryRun` short-circuits.
    if (!opts.dryRun) {
        // Index the cloud tenants by (provider, license) once so the
        // per-cell repo lookup below is an O(1) Map.get instead of a
        // .find() scan inside the loop.
        const repoByProviderLicense = new Map<string, string | undefined>();
        if (opts.target === 'cloud') {
            for (const e of readCloudTenantsFile()) {
                repoByProviderLicense.set(
                    `${e.provider}::${e.license}`,
                    e.repoFullName,
                );
            }
        }
        const fixtures = new Map<
            string,
            { provider: ProviderName; repo?: string }
        >();
        for (const c of opts.cells) {
            if (c.target !== opts.target) continue;
            // Same stale-tenants-file fallback as resolveCloudRepo (non-
            // throwing here: a cleanup miss is survivable, a dead run is
            // not) — otherwise the sweep visits the shared default repo
            // while the actual per-tenant repos keep their orphaned PRs.
            const repo =
                opts.target === 'cloud'
                    ? (repoByProviderLicense.get(
                          `${c.provider}::${c.license}`,
                      ) ?? registryRepoFor(c.provider, c.license))
                    : undefined;
            fixtures.set(`${c.provider}::${repo ?? 'default'}`, {
                provider: c.provider,
                repo,
            });
        }
        // Spread cleanup's repo/PR listing across the bot-account pool too —
        // otherwise every fixture lists on the single default account and helps
        // exhaust its per-account GitHub rate limit before the cells even run.
        const pickCleanupToken = makeGithubTokenPicker();
        for (const { provider: providerName, repo } of fixtures.values()) {
            const label = `${providerName}${repo ? ` (${repo})` : ''}`;
            try {
                const provider = makeProvider(
                    providerName,
                    opts.target,
                    repo,
                    providerName === 'github'
                        ? pickCleanupToken().token
                        : undefined,
                );
                const { closed } = await provider.cleanupStaleE2EArtifacts();
                if (closed > 0) {
                    log.info(
                        `[cleanup] ${label}: abandoned ${closed} stale [e2e]-prefixed PR(s) from prior runs`,
                    );
                }
            } catch (err) {
                // Best-effort. Don't poison the entire matrix run just
                // because cleanup couldn't list PRs on one fixture —
                // the per-scenario open path still throws its own
                // specific error if a stale PR ends up blocking it,
                // and that error is what the operator sees.
                log.info(
                    `[cleanup] ${label}: skipped (${err instanceof Error ? err.message : String(err)})`,
                );
            }
        }
    }

    // Round-robins GitHub cells across the bot-account token pool so no single
    // account's rate limit caps the run (no-op with a single token).
    const pickGithubToken = makeGithubTokenPicker();

    // Report each bot account's remaining GitHub budget up front (free — GET
    // /rate_limit doesn't count) so an already-drained or expired token is
    // visible before the cells run instead of as an opaque mid-run 403 cascade.
    if (!opts.dryRun && opts.cells.some((c) => c.provider === "github")) {
        await preflightGithubRateLimits(log);
        // …and the credential the PRODUCT stores, which the pool preflight
        // never looked at. It is a DIFFERENT account (or, when
        // GH_INTEGRATION_TOKEN is unset, silently the same one), and it is the
        // one /code-management/auth-integration validates against GitHub —
        // the exact call that exhausted run 31270321822 on its first scenario.
        await preflightIntegrationToken(log);
    }

    // Cloud tenants are seeded ONCE (setup-tenants) and persist their BYOK
    // key in the tenant's byok_config — so an LLM key rotation silently
    // strands every persistent QA tenant on the revoked key, and each review
    // dies with `partial_error: Incorrect API key` (observed 2026-07-28,
    // every paid cell red since the 07-24 rotation). Re-apply the CURRENT
    // env key to each registry tenant at run start: one login + one POST per
    // tenant, idempotent, skipped entirely when the env key is absent.
    if (!opts.dryRun && opts.target === 'cloud') {
        await refreshCloudTenantByok(log);
    }

    for (const cell of opts.cells) {
        if (cell.target !== opts.target) continue;

        const target = opts.dryRun
            ? {
                  target: cell.target,
                  apiBaseUrl: 'https://dry-run.invalid',
                  webBaseUrl: 'https://dry-run.invalid',
                  tunnelUrl: 'https://dry-run.invalid',
              }
            : envForTarget(cell.target, cell.provider);
        const tenant = opts.dryRun
            ? { email: 'dry-run@kodus.test', password: 'dry-run' }
            : await resolveTenantForCell(
                  target,
                  cell.license,
                  cell.provider,
                  opts.runId,
              );

        // Self-hosted: state the BYOK config EXPLICITLY on this cell's tenant.
        //
        // Without it the stack falls back to `API_LLM_PROVIDER_MODEL`, and
        // `describeEnvLLMConfig` infers the provider from the model name —
        // recognising only Gemini and Claude, so every OpenAI model routes as
        // `openai_compatible`. That is harmless for gpt-5.4-mini and fatal for
        // a reasoning model ("Function tools with reasoning_effort are not
        // supported ... in /v1/chat/completions").
        //
        // Writing the row takes the same path a customer takes through the UI,
        // so the matrix exercises the supported configuration rather than the
        // inferred one. Best-effort: a tenant that keeps its existing config is
        // still testable, and failing the cell here would trade a product
        // signal for a setup detail.
        if (
            cell.target === 'self-hosted' &&
            !opts.dryRun &&
            tenant &&
            process.env.API_OPEN_AI_API_KEY
        ) {
            try {
                const session = await login(target, tenant);
                const applied = await applyByokToTenant(target, session);
                const cfg = byokFromEnv();
                if (applied.ok) {
                    log.info(
                        `[byok] ${cell.provider}/${cell.license}: ${cfg.provider}:${cfg.model} written to the tenant`,
                    );
                } else {
                    log.warn(
                        `[byok] ${cell.provider}/${cell.license}: HTTP ${applied.status} — tenant keeps its existing config (env inference applies)`,
                    );
                }
            } catch (err) {
                log.warn(
                    `[byok] ${cell.provider}/${cell.license}: ${(err as Error).message.slice(0, 120)} — continuing on the tenant's existing config`,
                );
            }
        }

        // Circuit breaker: once a github bot account's quota is exhausted,
        // every remaining scenario in the cell would either re-hit the 403 or
        // hang polling for a product action the (also rate-limited) product
        // can't take — draining the whole 60-min job budget on retries. The
        // hour-long reset can't clear mid-cell, so short-circuit the rest to a
        // fast, honest SKIP instead. Resets per cell.
        let githubRateLimited = false;

        for (const scenario of opts.scenarios) {
            const cellLabel = `${scenario.id} × ${cell.target} × ${cell.provider} × ${cell.license}`;

            if (!appliesToCell(scenario, cell)) {
                log.info(`SKIP  ${cellLabel}`);
                results.push(
                    makeSkip(scenario, cell, 0, 'not-applicable'),
                );
                continue;
            }

            if (githubRateLimited) {
                log.err(
                    `SKIP  ${cellLabel}: GitHub rate limit already tripped this cell — short-circuiting (quota resets hourly, NOT a product pass)`,
                );
                results.push(
                    makeSkip(
                        scenario,
                        cell,
                        0,
                        'infra',
                        'github-rate-limit: cell circuit breaker (a prior scenario exhausted the account quota)',
                    ),
                );
                continue;
            }

            if (opts.dryRun) {
                log.info(`DRY   ${cellLabel}`);
                results.push(
                    makeResult(scenario, cell, 'passed', 0, {
                        dryRun: true,
                        wouldRun: true,
                        scenarioTitle: scenario.title,
                    }),
                );
                continue;
            }

            log.info(`RUN   ${cellLabel}`);

            // Assign this GitHub run a token from the bot-account pool
            // (round-robin). Same token across both attempts so a retry stays
            // on the same account; other cells keep draining the other tokens.
            const ghAssignment =
                cell.provider === "github" ? pickGithubToken() : undefined;
            let githubToken = ghAssignment?.token;
            if (ghAssignment && ghAssignment.size > 1) {
                log.info(
                    `  github → token slot ${ghAssignment.slot}/${ghAssignment.size}`,
                );
            }
            // GitHub App installation token (opt-in via GH_APP_* envs):
            // 5000/h of its own, immune to the bot-account abuse flags that
            // cap the PATs at ~60/h. Resolved per scenario so the ~1h token
            // auto-refreshes across long runs. A configured-but-broken App
            // fails the mint loudly; we surface it and fall back to the PAT
            // so one bad secret doesn't zero the coverage.
            //
            // Self-hosted used to be excluded because installation tokens
            // cannot call GET /user and seat assignment needs the user id.
            // provider.currentUserId() now resolves that ONE call from the
            // durable PAT, so both targets can put their heavy traffic on
            // the App budget — which is where the quota SKIPs came from.
            if (cell.provider === "github") {
                try {
                    const appToken = await githubAppToken();
                    if (appToken) {
                        githubToken = appToken;
                        log.info("  github → App installation token");
                    }
                } catch (err) {
                    log.err(
                        `  github → App token mint FAILED (${(err as Error).message.slice(0, 160)}) — falling back to PAT pool`,
                    );
                }
            }

            // One automatic retry for TRANSIENT failure shapes (lost
            // webhook, provider hiccup, network) — see isTransientFailure.
            // Deterministic assertion mismatches ("expected deny, got
            // allow", "Kody posted one") never retry: re-running can't
            // change a wrong value, only waste an LLM review.
            let failFastHit = false;
            let retriedAfter: string | undefined;
            const scenarioArtifactDir = join(
                artifactDir,
                `${scenario.id}-${cell.target}-${cell.provider}-${cell.license}`,
            );
            quotaSampler?.mark(scenario.id);
            for (let attempt = 1; attempt <= 2; attempt++) {
                const t0 = Date.now();
                // Attribute GitHub spend to a scenario, or to whatever else
                // shares this account. See integrationQuota().
                const quotaBefore =
                    cell.provider === 'github' && !opts.dryRun
                        ? await integrationQuota()
                        : undefined;
                if (quotaBefore && lastQuotaAfter) {
                    const idleSpend =
                        lastQuotaAfter.remaining - quotaBefore.remaining;
                    // Nothing of ours ran in this gap. A non-trivial number
                    // here means the account is shared, and no amount of
                    // tuning our own request volume will save the run.
                    if (idleSpend > 50) {
                        log.warn(
                            `[quota] integration account lost ${idleSpend} requests while NO scenario was running — ` +
                                'something outside this run shares that credential. Give the product a dedicated account.',
                        );
                    }
                }
                try {
                    const provider = makeProvider(
                        cell.provider,
                        cell.target,
                        tenant?.repoFullName,
                        githubToken,
                    );
                    mkdirSync(scenarioArtifactDir, { recursive: true });

                    // Runner-ENFORCED scenario timeout: scenario.timeoutSec
                    // was previously advisory only — a hung HTTP call or a
                    // leaked stream kept an attempt alive indefinitely
                    // (observed: 86 minutes). The race guarantees the
                    // attempt dies at the declared budget.
                    const timeoutMs = (scenario.timeoutSec ?? 1800) * 1000;
                    let timeoutHandle: NodeJS.Timeout | undefined;
                    const timeoutGuard = new Promise<never>((_, reject) => {
                        timeoutHandle = setTimeout(
                            () =>
                                reject(
                                    new Error(
                                        `Assertion failed: scenario exceeded its ${scenario.timeoutSec ?? 1800}s budget (runner-enforced timeout)`,
                                    ),
                                ),
                            timeoutMs,
                        );
                        timeoutHandle.unref?.();
                    });
                    const evidence = await Promise.race([
                        timeoutGuard,
                        scenario.run({
                            target,
                            provider,
                            license: cell.license,
                            tenant,
                            kodus: {
                                login: (creds) => login(target, creds),
                                registerIntegration: (session) =>
                                    registerIntegration(
                                        target,
                                        provider,
                                        session,
                                    ),
                                registerRepo: (session, repoOpts) =>
                                    registerRepo(
                                        target,
                                        provider,
                                        session,
                                        repoOpts,
                                    ),
                                finishOnboarding: (session, repo) =>
                                    finishOnboarding(target, session, repo),
                            },
                            assert: (cond, msg) => {
                                if (!cond)
                                    throw new Error(`Assertion failed: ${msg}`);
                            },
                            skip: (reason: string): never => {
                                throw new ScenarioSkipError(reason);
                            },
                            artifactDir: scenarioArtifactDir,
                            runId: opts.runId,
                        }),
                    ]).finally(() => clearTimeout(timeoutHandle));

                    const duration = Date.now() - t0;
                    log.ok(
                        `PASS  ${cellLabel}  (${(duration / 1000).toFixed(1)}s)${retriedAfter ? ' [on retry]' : ''}`,
                    );
                    results.push({
                        ...makeResult(
                            scenario,
                            cell,
                            'passed',
                            duration,
                            retriedAfter
                                ? { ...evidence, retriedAfter }
                                : evidence,
                        ),
                        // A cell that only passes on attempt 2 is a flake.
                        // It still counts as passed, but it is counted
                        // SEPARATELY — an intermittent product bug that the
                        // retry keeps absorbing is exactly what nobody was
                        // able to see before.
                        ...(retriedAfter ? { flaky: true } : {}),
                    });
                    break;
                } catch (err) {
                    const duration = Date.now() - t0;
                    const e = err as Error;
                    // ctx.skip() surfaces here as a recognized sentinel.
                    // Mark the cell as skipped (not failed) so the bottom-
                    // line summary stays accurate and the matrix run as a
                    // whole isn't dragged into "failed" by a precondition
                    // gap (e.g. upgrade-n-1-to-n outside the upgrade flow).
                    // Identity check by .name to survive bundlers that
                    // drop the prototype chain.
                    if (
                        e instanceof ScenarioSkipError ||
                        e?.name === 'ScenarioSkipError'
                    ) {
                        log.info(`SKIP  ${cellLabel}  (${e.message})`);
                        results.push(
                            makeSkip(
                                scenario,
                                cell,
                                duration,
                                'setup',
                                e.message,
                            ),
                        );
                        break;
                    }
                    // GitHub rate limit (per-account, hourly reset): an in-run
                    // retry can't clear it, so SKIP (infra, non-gating) instead
                    // of failing the release red. Logged loudly so a wall of
                    // these reads as "out of quota / spread load", not a pass.
                    if (isGithubRateLimit(e.message)) {
                        // Trip the per-cell breaker so the remaining scenarios
                        // fast-SKIP instead of each re-hitting the 403 or
                        // hanging on the rate-limited product until timeout.
                        githubRateLimited = true;
                        log.err(
                            `SKIP  ${cellLabel}: GitHub rate limit — quota exhausted, NOT a product pass (${e.message.slice(0, 160)})`,
                        );
                        results.push(
                            makeSkip(
                                scenario,
                                cell,
                                duration,
                                'infra',
                                `github-rate-limit: ${e.message.slice(0, 200)}`,
                            ),
                        );
                        break;
                    }
                    if (
                        attempt === 1 &&
                        !opts.failFast &&
                        isTransientFailure(e.message)
                    ) {
                        retriedAfter = e.message;
                        const settleMs = absenceRetryDelayMs(e.message);
                        log.info(
                            `RETRY ${cellLabel}: transient failure shape, re-running once${settleMs ? ` after a ${settleMs / 1000}s settle (absence shape — likely a deploy/worker rollout window)` : ''} (${e.message.slice(0, 160)})`,
                        );
                        if (settleMs) {
                            await settle(settleMs);
                        }
                        continue;
                    }
                    // Infra vs product: if the target itself is down, the
                    // result is INCONCLUSIVE (skipped), not a red product
                    // signal — a local network blip used to read exactly
                    // like a regression.
                    if (!(await isTargetReachable(target.apiBaseUrl))) {
                        log.err(
                            `SKIP  ${cellLabel}: target unreachable after failure — INCONCLUSIVE, not a product fail (${e.message.slice(0, 140)})`,
                        );
                        results.push(
                            makeSkip(
                                scenario,
                                cell,
                                duration,
                                'infra',
                                `target-unreachable: ${e.message.slice(0, 200)}`,
                            ),
                        );
                        break;
                    }
                    // Server-side evidence (best-effort, self-hosted only):
                    // filtered container logs land next to the scenario's
                    // artifacts so a red result is diagnosable without
                    // manual SSH archaeology.
                    await collectServerEvidence(
                        scenarioArtifactDir,
                        `${scenario.id}-fail`,
                    );
                    log.err(`FAIL  ${cellLabel}: ${e.message}`);
                    results.push(
                        makeResult(
                            scenario,
                            cell,
                            'failed',
                            duration,
                            retriedAfter ? { retriedAfter } : {},
                            e.message,
                            e.stack,
                        ),
                    );
                    if (opts.failFast) failFastHit = true;
                    break;
                } finally {
                    if (quotaBefore) {
                        const after = await integrationQuota();
                        if (after) {
                            const spent =
                                quotaBefore.remaining - after.remaining;
                            // Logged on every scenario, not only when it goes
                            // wrong: the number that matters is the one from
                            // the run that PASSED, because that is the budget
                            // the next scenario has left to work with.
                            log.info(
                                `[quota] ${scenario.id}: integration account spent ${spent} github requests ` +
                                    `(${after.remaining}/${after.limit} left, resets ${after.resetIso})`,
                            );
                            lastQuotaAfter = after;
                        }
                    }
                }
            }
            quotaSampler?.mark(IDLE);
            if (failFastHit) break;
        }
    }

    if (quotaSampler) {
        const curve = quotaSampler.stop();
        for (const line of describeQuotaCurve(curve)) {
            log.info(line);
        }
        writeFileSync(
            join(artifactDir, 'quota-curve.json'),
            JSON.stringify(
                {
                    samples: quotaSampler.samples,
                    marks: quotaSampler.marks,
                    summary: curve,
                },
                null,
                2,
            ),
        );
    }

    return {
        runId: opts.runId,
        startedAt,
        finishedAt: new Date().toISOString(),
        results,
    };
}

function makeResult(
    scenario: Scenario,
    cell: MatrixCell,
    status: ScenarioStatus,
    durationMs: number,
    evidence: Record<string, unknown>,
    errorMessage?: string,
    errorStack?: string,
): ScenarioResult {
    const now = new Date().toISOString();
    return {
        scenarioId: scenario.id,
        cell,
        status,
        durationMs,
        evidence,
        errorMessage,
        errorStack,
        startedAt: now,
        finishedAt: now,
    };
}

// Every `skipped` result goes through here so it CANNOT be recorded without
// saying why. `not-applicable` is the only silent kind; `setup` and `infra`
// both mean a check we believe we have did not actually run.
function makeSkip(
    scenario: Scenario,
    cell: MatrixCell,
    durationMs: number,
    kind: SkipKind,
    reason?: string,
): ScenarioResult {
    return {
        ...makeResult(
            scenario,
            cell,
            'skipped',
            durationMs,
            reason ? { skipReason: reason } : {},
        ),
        skipKind: kind,
    };
}

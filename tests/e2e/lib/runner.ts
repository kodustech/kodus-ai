import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
    LicenseMode,
    MatrixCell,
    ProviderName,
    Scenario,
    ScenarioResult,
    ScenarioStatus,
    Target,
    TargetContext,
    TenantCredentials,
} from "./types.js";
import { ScenarioSkipError } from "./types.js";
import { makeProvider } from "../providers/index.js";
import {
    finishOnboarding,
    login,
    registerIntegration,
    registerRepo,
    signUp,
} from "./onboarding.js";
import { randomBytes } from "node:crypto";
import { logger } from "./log.js";

const log = logger("runner");

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

function appliesToCell(scenario: Scenario, cell: MatrixCell): boolean {
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
    return provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function envForTarget(
    target: Target,
    provider?: ProviderName,
): TargetContext {
    if (target === "cloud") {
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
            process.env.CLOUD_WEB_BASE_URL ?? "https://qa.web.kodus.io";
        const apiBaseUrl =
            process.env.CLOUD_API_BASE_URL ??
            `${webBaseUrl.replace(/\/$/, "")}/api/proxy/api`;
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
        perProvider("SELFHOSTED_API_BASE_URL") ??
        process.env.SELFHOSTED_API_BASE_URL ??
        process.env.TARGET_BASE_URL ??
        (() => {
            throw new Error(
                `SELFHOSTED_API_BASE_URL_${sfx ?? "<PROVIDER>"} or SELFHOSTED_API_BASE_URL or TARGET_BASE_URL is required for self-hosted target (e.g. http://1.2.3.4:3001)`,
            );
        })();
    const webBaseUrl =
        perProvider("SELFHOSTED_WEB_URL") ??
        process.env.SELFHOSTED_WEB_URL ??
        process.env.TARGET_WEB_URL ??
        apiBaseUrl.replace(/:3001$/, ":3000");
    const tunnelUrl =
        perProvider("SELFHOSTED_TUNNEL_URL") ??
        process.env.SELFHOSTED_TUNNEL_URL ??
        process.env.TARGET_TUNNEL_URL;
    if (!tunnelUrl) {
        throw new Error(
            `SELFHOSTED_TUNNEL_URL_${sfx ?? "<PROVIDER>"} or SELFHOSTED_TUNNEL_URL or TARGET_TUNNEL_URL is required for self-hosted target (e.g. https://xxx.trycloudflare.com)`,
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
}

function readCloudTenantsFile(): CloudTenantEntry[] {
    const path = join(homedir(), ".kodus-dev", "cloud-tenants.json");
    if (!existsSync(path)) return [];
    try {
        const raw = readFileSync(path, "utf8");
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as CloudTenantEntry[]) : [];
    } catch {
        return [];
    }
}

async function resolveTenantForCell(
    target: TargetContext,
    license: LicenseMode,
    provider: ProviderName,
    runId: string,
): Promise<TenantCredentials | undefined> {
    if (target.target === "cloud") {
        // Preferred path (post-cloud:setup-tenants): match by
        // (provider, license) in ~/.kodus-dev/cloud-tenants.json. Each
        // entry has email + password + the resolved org/team uuids the
        // setup phase persisted.
        const entries = readCloudTenantsFile();
        const match = entries.find(
            (e) => e.provider === provider && e.license === license,
        );
        if (match) return { email: match.email, password: match.password };

        // Legacy fallback: per-license env vars (CLOUD_TENANT_PAID_EMAIL
        // etc.). Kept so a one-off run can drive a hand-seeded tenant
        // without touching the JSON file.
        const map: Record<string, [string, string] | undefined> = {
            free: ["CLOUD_TENANT_FREE_EMAIL", "CLOUD_TENANT_FREE_PASSWORD"],
            trial: ["CLOUD_TENANT_TRIAL_EMAIL", "CLOUD_TENANT_TRIAL_PASSWORD"],
            paid: ["CLOUD_TENANT_PAID_EMAIL", "CLOUD_TENANT_PAID_PASSWORD"],
        };
        const key = map[license];
        if (!key) return undefined;
        const email = process.env[key[0]];
        const password = process.env[key[1]];
        if (!email || !password) return undefined;
        return { email, password };
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
        `e2e-${provider}-${runId.slice(0, 16).replace(/[^a-z0-9-]/gi, "")}@kodus.local`;
    const password =
        process.env.SH_TENANT_PASSWORD ??
        process.env.TEST_USER_PASSWORD ??
        `E2eSmoke!${randomBytes(4).toString("hex")}`;
    await signUp(target, { email, password });
    return { email, password };
}

export async function runMatrix(opts: RunOptions): Promise<RunOutcome> {
    const startedAt = new Date().toISOString();
    const results: ScenarioResult[] = [];
    const artifactDir = join(opts.artifactRoot, opts.runId);
    mkdirSync(artifactDir, { recursive: true });

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
    // provider so 4 cells × 1 provider only hit the upstream API
    // once. `opts.dryRun` short-circuits (no upstream calls).
    if (!opts.dryRun) {
        const uniqueProviders = Array.from(
            new Set(
                opts.cells
                    .filter((c) => c.target === opts.target)
                    .map((c) => c.provider),
            ),
        );
        for (const providerName of uniqueProviders) {
            try {
                const provider = makeProvider(providerName, opts.target);
                const { closed } = await provider.cleanupStaleE2EArtifacts();
                if (closed > 0) {
                    log.info(
                        `[cleanup] ${providerName}: abandoned ${closed} stale [e2e]-prefixed PR(s) from prior runs`,
                    );
                }
            } catch (err) {
                // Best-effort. Don't poison the entire matrix run just
                // because cleanup couldn't list PRs on one provider —
                // the per-scenario open path still throws its own
                // specific error if a stale PR ends up blocking it,
                // and that error is what the operator sees.
                log.info(
                    `[cleanup] ${providerName}: skipped (${err instanceof Error ? err.message : String(err)})`,
                );
            }
        }
    }

    for (const cell of opts.cells) {
        if (cell.target !== opts.target) continue;

        const target = opts.dryRun
            ? {
                  target: cell.target,
                  apiBaseUrl: "https://dry-run.invalid",
                  webBaseUrl: "https://dry-run.invalid",
                  tunnelUrl: "https://dry-run.invalid",
              }
            : envForTarget(cell.target, cell.provider);
        const tenant = opts.dryRun
            ? { email: "dry-run@kodus.test", password: "dry-run" }
            : await resolveTenantForCell(
                  target,
                  cell.license,
                  cell.provider,
                  opts.runId,
              );

        for (const scenario of opts.scenarios) {
            const cellLabel = `${scenario.id} × ${cell.target} × ${cell.provider} × ${cell.license}`;

            if (!appliesToCell(scenario, cell)) {
                log.info(`SKIP  ${cellLabel}`);
                results.push(makeResult(scenario, cell, "skipped", 0, {}));
                continue;
            }

            if (opts.dryRun) {
                log.info(`DRY   ${cellLabel}`);
                results.push(
                    makeResult(scenario, cell, "passed", 0, {
                        dryRun: true,
                        wouldRun: true,
                        scenarioTitle: scenario.title,
                    }),
                );
                continue;
            }

            log.info(`RUN   ${cellLabel}`);
            const t0 = Date.now();
            try {
                const provider = makeProvider(cell.provider, cell.target);
                const scenarioArtifactDir = join(
                    artifactDir,
                    `${scenario.id}-${cell.target}-${cell.provider}-${cell.license}`,
                );
                mkdirSync(scenarioArtifactDir, { recursive: true });

                const evidence = await scenario.run({
                    target,
                    provider,
                    license: cell.license,
                    tenant,
                    kodus: {
                        login: (creds) => login(target, creds),
                        registerIntegration: (session) =>
                            registerIntegration(target, provider, session),
                        registerRepo: (session) =>
                            registerRepo(target, provider, session),
                        finishOnboarding: (session, repo) =>
                            finishOnboarding(target, session, repo),
                    },
                    assert: (cond, msg) => {
                        if (!cond) throw new Error(`Assertion failed: ${msg}`);
                    },
                    skip: (reason: string): never => {
                        throw new ScenarioSkipError(reason);
                    },
                    artifactDir: scenarioArtifactDir,
                    runId: opts.runId,
                });

                const duration = Date.now() - t0;
                log.ok(`PASS  ${cellLabel}  (${(duration / 1000).toFixed(1)}s)`);
                results.push(
                    makeResult(scenario, cell, "passed", duration, evidence),
                );
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
                    e?.name === "ScenarioSkipError"
                ) {
                    log.info(`SKIP  ${cellLabel}  (${e.message})`);
                    results.push(
                        makeResult(scenario, cell, "skipped", duration, {
                            skipReason: e.message,
                        }),
                    );
                    continue;
                }
                log.err(`FAIL  ${cellLabel}: ${e.message}`);
                results.push(
                    makeResult(
                        scenario,
                        cell,
                        "failed",
                        duration,
                        {},
                        e.message,
                        e.stack,
                    ),
                );
                if (opts.failFast) break;
            }
        }
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

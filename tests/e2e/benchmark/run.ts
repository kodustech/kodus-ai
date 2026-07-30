// Tier-0 per-model code-review benchmark runner (mechanical gate).
//
// For each recommended model (curated-models.json): point ONE QA benchmark
// tenant's BYOK at the model, open the fixed 5-PR set (1 per repo) on the
// shared kodus-e2e benchmark repos, wait for Kody to review each, and collect
// the findings. Sequential across models (single tenant, BYOK swapped) so the
// lone webhook never cross-fires. Emits results.json:
//   { model, pr: {repo, number, head, golden_comments, findings[] } }
//
// SUCCESS = all (models × 5) reviews complete correctly (the mechanical gate).
// The precision/recall scorecard vs golden_comments is a separate post-step
// (judge.ts) over results.json — NOT a pass/fail here.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { GitHubProvider } from "../providers/github.js";
import { login, registerIntegration, signUp } from "../lib/onboarding.js";
import { finishOnboarding, resetCodeReviewConfig } from "../lib/onboarding.js";
import { http, ensureOk } from "../lib/http.js";
import { logger } from "../lib/log.js";
import { loadTier0Models, type BenchModel } from "./models.js";
import { setByokConfig, testByok } from "./byok.js";
import type { TargetContext, KodusSession } from "../lib/types.js";

const log = logger("bench");

const QA_WEB = process.env.CLOUD_WEB_BASE_URL ?? "https://qa.web.kodus.io";
const QA: TargetContext = {
    target: "cloud",
    apiBaseUrl: `${QA_WEB.replace(/\/$/, "")}/api/proxy/api`,
    webBaseUrl: QA_WEB,
};

interface BenchPR {
    repo: string; // kodus-e2e/<name>
    head: string;
    base: string;
    title: string;
    golden_comments: { comment: string; severity?: string }[];
}

// Make `pnpm run benchmark:models` a true one-command: pull BYOK_* / GH_TEST_TOKEN
// / ANTHROPIC_API_KEY from ~/.kodus-dev/config if they're not already in the
// env. Indent-tolerant (the config lines may be indented); never overrides an
// env var the caller already set.
function loadConfig(): void {
    const path = join(homedir(), ".kodus-dev", "config");
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch {
        return;
    }
    for (const line of text.split("\n")) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (!m) continue;
        const [, k, vRaw] = m;
        if (process.env[k] !== undefined) continue;
        const v = vRaw.replace(/^["']|["']$/g, "");
        if (v.startsWith("op://")) continue; // unresolved 1Password ref — skip
        process.env[k] = v;
    }
}

function loadPRs(): BenchPR[] {
    const p = join(process.cwd(), "..", "..", "scripts", "benchmark", "tier0-bench-prs.json");
    return JSON.parse(readFileSync(p, "utf8")).prs as BenchPR[];
}

// Dedicated benchmark tenant. Defaults to a fixed bench account so
// `pnpm run benchmark:models` is one command and never mutates the shared cloud
// QA tenants; override via env for a one-off. signUp is idempotent (409-OK),
// so first run creates it and later runs reuse it.
async function getSession(): Promise<KodusSession> {
    // `||` (not `??`) so an EMPTY string falls through to the default too.
    // CI passes `${{ secrets.X }}` which is "" when the secret is unset, and
    // "" is not null/undefined → `??` would keep it → empty creds → 401. An
    // empty email/password is never valid here, so `||` is strictly safer.
    const email = process.env.BENCH_TENANT_EMAIL || "e2e-bench-tier0@kodus.io";
    const password =
        process.env.BENCH_TENANT_PASSWORD ||
        process.env.TEST_USER_PASSWORD ||
        "E2eBench!a1b2c3d4";
    await signUp(QA, { email, password }).catch(() => {});
    return login(QA, { email, password });
}

// List the repos the team's integration can see. Each carries `selected`
// (true = already onboarded for review). Empty/throws on a tenant with no
// integration yet — callers treat that as "not onboarded".
async function listOrgRepos(
    session: KodusSession,
): Promise<Array<Record<string, unknown>>> {
    const resp = await http<{ data: Array<Record<string, unknown>> }>(
        `${QA.apiBaseUrl}/code-management/repositories/org?teamId=${encodeURIComponent(session.teamId)}`,
        { headers: { Authorization: `Bearer ${session.accessToken}` }, timeoutMs: 30_000 },
    );
    return resp.status >= 200 && resp.status < 300 ? resp.body.data ?? [] : [];
}

// Onboard the benchmark repos for review — but ONLY if they aren't already.
// Re-running type:"replace" on a tenant that already has them deletes +
// recreates the repo records and their webhooks, and the recreated state
// stops firing reviews (webhook delivers 200 but Kody never reviews — observed
// repeatedly). So this is strictly idempotent: if every benchmark repo is
// already `selected`, do nothing; the existing (working) webhooks stay intact.
async function registerRepos(
    session: KodusSession,
    repoFullNames: string[],
): Promise<void> {
    const avail = await listOrgRepos(session);
    const availByName = new Map(avail.map((x) => [x.full_name as string, x]));
    const found = repoFullNames.map((fn) => {
        const r = availByName.get(fn);
        if (!r) {
            throw new Error(
                `benchmark repo ${fn} not in integration's available list (${avail.length} repos). Sample: ${JSON.stringify(avail.slice(0, 6).map((x) => x.full_name))}`,
            );
        }
        return r;
    });
    if (found.every((r) => r.selected === true)) {
        log.info(`${found.length} benchmark repos already onboarded — skipping re-register (avoids the re-onboard review-break)`);
        return;
    }
    const resp = await http<{ data: { status: boolean } }>(
        `${QA.apiBaseUrl}/code-management/repositories`,
        {
            method: "POST",
            headers: { Authorization: `Bearer ${session.accessToken}` },
            body: { teamId: session.teamId, type: "replace", repositories: found },
            timeoutMs: 30_000,
        },
    );
    ensureOk(resp, "bench:registerRepos");
    log.ok(`onboarded ${found.length} benchmark repos`);
}

// Put the org into the `free_byok` plan so the cloud review gate
// (permissionValidation.service.ts) allows reviews: it requires
// validation.valid===true AND planType containing "byok" AND a stored BYOK
// config. A brand-new free signup has NO license row, so EVERY PR is gated out
// silently (webhook 200, no review). This is the same three-step dance the UI /
// setup-tenants seeder does: trial → byok config → migrate-to-free. Idempotent:
// 409 / "already" on a tenant that's already provisioned is success.
async function ensureReviewLicense(
    session: KodusSession,
    seedModel: BenchModel,
): Promise<void> {
    const billing = `${QA.webBaseUrl.replace(/\/$/, "")}/api/proxy/billing`;
    const auth = { Authorization: `Bearer ${session.accessToken}` };
    const body = { organizationId: session.organizationId, teamId: session.teamId };
    const okOrAlready = (s: number, raw: string) =>
        (s >= 200 && s < 300) || s === 409 || (s === 400 && /already|trial|existe|free_byok/i.test(raw));

    const trial = await http(`${billing}/trial`, {
        method: "POST", headers: auth, body: { ...body, byok: true }, timeoutMs: 30_000,
    });
    if (!okOrAlready(trial.status, trial.raw)) {
        throw new Error(`billing/trial failed: HTTP ${trial.status} ${trial.raw.slice(0, 200)}`);
    }
    // Gate needs a stored BYOK config before migrate-to-free flips planType.
    await setByokConfig({ apiBaseUrl: QA.apiBaseUrl, accessToken: session.accessToken }, seedModel);
    const migrate = await http(`${billing}/migrate-to-free`, {
        method: "POST", headers: auth, body, timeoutMs: 30_000,
    });
    if (!okOrAlready(migrate.status, migrate.raw)) {
        throw new Error(`billing/migrate-to-free failed: HTTP ${migrate.status} ${migrate.raw.slice(0, 200)}`);
    }
    log.ok(`review license ready (free_byok plan)`);
}

// Idempotent end-to-end onboarding. If the benchmark repos are already
// onboarded (selected) we touch NOTHING — not the integration, not the repos —
// so a re-run (CI nightly, local) never re-registers and never breaks the live
// webhooks. Only a fresh tenant pays the full registerIntegration + register.
async function ensureOnboarded(
    session: KodusSession,
    repoFullNames: string[],
): Promise<void> {
    let avail = await listOrgRepos(session);
    const selectedNames = new Set(
        avail.filter((r) => r.selected === true).map((r) => r.full_name as string),
    );
    const allSelected =
        avail.length > 0 && repoFullNames.every((fn) => selectedNames.has(fn));
    if (!allSelected) {
        const provider0 = new GitHubProvider({ repoOverride: repoFullNames[0], target: "cloud" });
        await registerIntegration(QA, provider0, session);
        await registerRepos(session, repoFullNames);
        avail = await listOrgRepos(session); // refresh to pick up repo ids
    } else {
        log.ok(`benchmark repos already onboarded — skipping re-register`);
    }
    // Registering repos is NOT enough: the webhook handler only reviews a PR
    // when the team has an ACTIVE AUTOMATION_CODE_REVIEW row, and that row is
    // activated by finish-onboarding — not by registerRepos. Without this every
    // PR webhook delivers 200 but is silently dropped ("no active code-review
    // automation") and no review is ever produced. finish-onboarding doesn't
    // touch webhooks, so it's safe to (re)run idempotently; it also waits out
    // the activation-commit race + re-asserts automatedReviewActive.
    const first = avail.find((r) => r.full_name === repoFullNames[0]);
    if (!first) throw new Error(`onboarded repo ${repoFullNames[0]} not found after register`);
    await finishOnboarding(QA, session, {
        id: String(first.id),
        name: String(first.name),
        full_name: String(first.full_name),
    });
    log.ok(`code-review automation activated (finish-onboarding)`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// GitHub GET with retries on transient failures (5xx / 429 / network) — the
// shared http() helper only retries transport errors, and CI must never flake
// on a single hiccup. Throws only after exhausting attempts on a hard error.
async function ghGetJson<T>(url: string): Promise<T> {
    const headers = {
        Authorization: `Bearer ${process.env.GH_TEST_TOKEN!}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    };
    let lastErr: unknown;
    for (let attempt = 0; attempt < 6; attempt++) {
        try {
            const r = await fetch(url, { headers });
            if (r.ok) return (await r.json()) as T;
            if (r.status === 429 || r.status >= 500) {
                await sleep(2000 * 2 ** attempt);
                continue;
            }
            throw new Error(`GitHub ${r.status} on ${url}: ${(await r.text()).slice(0, 150)}`);
        } catch (e) {
            lastErr = e;
            await sleep(2000 * 2 ** attempt);
        }
    }
    throw new Error(`ghGetJson exhausted retries: ${url} (${(lastErr as Error)?.message})`);
}

// Findings are INLINE review comments (pulls/{n}/comments). The "Code Review
// Started/Completed" banners are ISSUE comments (summaries), NOT findings. Each
// inline comment carries a kody badge — that marks it a finding, so we must NOT
// filter on the marker (an earlier bug dropped every finding). Strip the badge.
async function collectFindings(repo: string, prNumber: number): Promise<string[]> {
    const body = await ghGetJson<{ body?: string }[]>(
        `https://api.github.com/repos/${repo}/pulls/${prNumber}/comments?per_page=100`,
    );
    return (body ?? [])
        .map((c) => (c.body ?? "").trim())
        .filter((b) => b && !b.toLowerCase().startsWith("@kody"))
        .map((b) => b.replace(/^(?:\s*!\[[^\]]*\]\([^)]*\)\s*)+/i, "").trim());
}

// Wait for the EXPLICIT completion signal — Kody posts a "## Code Review
// Completed! 🔥" issue comment when it finishes (verified on every reviewed
// PR). This is deterministic: a slow model (e.g. Moonshot took 42min) just
// waits longer; we never falsely declare "no review" on a blind timer (the old
// pollForReview gave up at 25min and mislabeled a review that landed at min 42).
// Returns true once the marker appears, false only after a generous cap.
type ReviewOutcome = "completed" | "failed" | "timeout";

async function waitForReviewOutcome(
    repo: string,
    prNumber: number,
    sinceMs: number,
    capSec = 3000,
): Promise<ReviewOutcome> {
    const deadline = Date.now() + capSec * 1000;
    while (Date.now() < deadline) {
        try {
            const comments = await ghGetJson<
                { body?: string; created_at?: string }[]
            >(
                `https://api.github.com/repos/${repo}/issues/${prNumber}/comments?per_page=100`,
            );
            // Only consider comments at/after `sinceMs` so a retry isn't fooled
            // by the previous attempt's banner still on the PR.
            const fresh = comments.filter(
                (c) => !c.created_at || new Date(c.created_at).getTime() >= sinceMs,
            );
            // Failure first: a "Could Not Complete ⚠️" banner (usually a transient
            // model/provider error, e.g. an openai_compatible 5xx) is terminal for
            // this attempt — return immediately instead of burning the ~50min cap.
            if (fresh.some((c) => /could not complete|review failed before/i.test(c.body ?? ""))) {
                return "failed";
            }
            // Kody posts ONE of two completion banners depending on findings:
            //   "## Code Review Completed! 🔥"   (issues found / standard)
            //   "# Kody Review Complete … No issues were found"  (zero findings)
            if (fresh.some((c) => /review complet(ed|e)\b/i.test(c.body ?? ""))) {
                return "completed";
            }
        } catch { /* transient — keep polling */ }
        await sleep(15_000);
    }
    return "timeout";
}

// After "Completed" the inline findings can still trickle in for a few seconds;
// poll until the count is stable across two reads (capped).
async function collectFindingsStable(repo: string, prNumber: number): Promise<string[]> {
    let prev = await collectFindings(repo, prNumber);
    for (let i = 0; i < 6; i++) {
        await sleep(10_000);
        const next = await collectFindings(repo, prNumber);
        if (next.length === prev.length) return next; // stable
        prev = next;
    }
    return prev;
}

type ModelOutcome = { ok: number; fail: number; results: unknown[] };

// Open each PR, wait for Kody, collect findings, close. `prs` already carry the
// right repo names (shared fixtures in sequential mode, per-model copies in
// parallel mode), so this is topology-agnostic.
async function reviewOnePR(model: BenchModel, pr: BenchPR): Promise<{ ok: boolean; result: unknown }> {
    const provider = new GitHubProvider({ repoOverride: pr.repo, target: "cloud" });
    const repoShort = pr.repo.split("/")[1];
    let opened;
    try {
        const openedAt = Date.now();
        opened = await provider.openPRFromBranches!({ head: pr.head, base: pr.base, title: `[bench] ${model.slug} ${repoShort}`, body: `Model benchmark: ${model.id}` });
        // Wait for Kody's terminal marker (Completed / Could-Not-Complete /
        // timeout). A non-completed first attempt is retried ONCE via
        // `@kody review`: a "Could Not Complete" is usually a transient model/
        // provider error (Kody itself tells you to re-run), and a single flake
        // would otherwise red the whole 25-review gate.
        let outcome = await waitForReviewOutcome(pr.repo, opened.number, openedAt - 5_000);
        let retried = false;
        if (outcome !== "completed") {
            retried = true;
            log.info(`${model.slug} ${repoShort}: review ${outcome} — retrying once via @kody review (PR #${opened.number})`);
            // GitHub comment `created_at` is second-precision, so `sinceMs` needs
            // the same -5s padding `openedAt` uses or a banner posted in the same
            // second would be filtered out (its timestamp truncates to .000 <
            // sinceMs) and the poll would hang the full cap. But padding back 5s
            // would also re-match the FIRST attempt's failure banner — so first
            // sleep 5s to push it outside the window, then pad.
            await sleep(5_000);
            const retryAt = Date.now() - 5_000;
            await provider.postComment(opened.number, "@kody review").catch(() => {});
            outcome = await waitForReviewOutcome(pr.repo, opened.number, retryAt);
        }
        const reviewed = outcome === "completed";
        const findings = reviewed ? await collectFindingsStable(pr.repo, opened.number) : [];
        if (reviewed) log.ok(`${model.slug} ${repoShort}: reviewed (${findings.length} findings)${retried ? " [after retry]" : ""}`);
        else log.err(`${model.slug} ${repoShort}: ${outcome} after retry (PR #${opened.number})`);
        return { ok: reviewed, result: { model: model.slug, modelId: model.id, repo: pr.repo, prNumber: opened.number, head: pr.head, golden_comments: pr.golden_comments, findings, retried } };
    } catch (err) {
        log.err(`${model.slug} ${pr.repo}: ${(err as Error).message}`);
        return { ok: false, result: { model: model.slug, repo: pr.repo, head: pr.head, error: (err as Error).message } };
    } finally {
        if (opened) await provider.closePR(opened).catch(() => {});
    }
}

// All 5 PRs run CONCURRENTLY — each is a distinct repo (isolated per-model copy,
// or a distinct shared fixture), so their webhooks never collide. Combined with
// the 6 models running in parallel, that's up to 30 reviews in flight, bounded
// by the slowest single review instead of the sum (a slow model no longer drags
// the whole run to ~2h).
async function reviewPRs(
    model: BenchModel,
    prs: BenchPR[],
): Promise<ModelOutcome> {
    const outcomes = await Promise.all(prs.map((pr) => reviewOnePR(model, pr)));
    const results = outcomes.map((o) => o.result);
    const ok = outcomes.filter((o) => o.ok).length;
    return { ok, fail: outcomes.length - ok, results };
}

// SEQUENTIAL mode: one shared tenant, BYOK swapped per model on the shared
// fixture repos. Must run models one at a time (BYOK_CONFIG is org-level — two
// models on one tenant would clobber each other).
async function runModelShared(
    model: BenchModel,
    session: KodusSession,
    prs: BenchPR[],
): Promise<ModelOutcome> {
    log.info(`=== model ${model.slug} (${model.id}) ===`);
    const s = { apiBaseUrl: QA.apiBaseUrl, accessToken: session.accessToken };
    const tb = await testByok(s, model);
    if (!tb.ok) throw new Error(`test-byok failed for ${model.slug}: ${tb.code} ${tb.message ?? ""}`);
    await setByokConfig(s, model);
    await resetCodeReviewConfig(QA, session);
    log.ok(`${model.slug}: BYOK set + validated (${tb.latencyMs}ms)`);
    return reviewPRs(model, prs);
}

const benchPassword = () =>
    process.env.BENCH_TENANT_PASSWORD || process.env.TEST_USER_PASSWORD || "E2eBench!a1b2c3d4";

// PARALLEL mode: each model gets its OWN tenant + its OWN copy of the fixture
// repos (kodus-e2e/<base>-<slug>), so no BYOK clobber and no shared-repo webhook
// collision — all 6 models run concurrently. Requires the isolated repos to
// exist (provision-repos.ts).
async function runModelIsolated(
    model: BenchModel,
    prs: BenchPR[],
): Promise<ModelOutcome> {
    const email = `e2e-bench-${model.slug}@kodus.io`;
    const password = benchPassword();
    await signUp(QA, { email, password }).catch(() => {});
    const session = await login(QA, { email, password });
    const myPRs = prs.map((p) => ({ ...p, repo: `${p.repo}-${model.slug}` }));
    log.info(`=== model ${model.slug} (isolated tenant ${email}) ===`);
    await ensureReviewLicense(session, model);
    await ensureOnboarded(session, myPRs.map((p) => p.repo));
    const s = { apiBaseUrl: QA.apiBaseUrl, accessToken: session.accessToken };
    const tb = await testByok(s, model);
    if (!tb.ok) throw new Error(`test-byok failed for ${model.slug}: ${tb.code} ${tb.message ?? ""}`);
    await setByokConfig(s, model);
    await resetCodeReviewConfig(QA, session);
    log.ok(`${model.slug}: tenant ready + BYOK set (${tb.latencyMs}ms)`);
    return reviewPRs(model, myPRs);
}

// Parallel is available once the per-model repos exist. Probe the first
// model's first copy; fall back to sequential-shared otherwise.
async function isolatedReposReady(models: BenchModel[], prs: BenchPR[]): Promise<boolean> {
    const probe = `${prs[0].repo}-${models[0].slug}`;
    try {
        const r = await fetch(`https://api.github.com/repos/${probe}`, {
            headers: { Authorization: `Bearer ${process.env.GH_TEST_TOKEN}`, Accept: "application/vnd.github+json" },
        });
        return r.ok;
    } catch { return false; }
}

// Models excluded from the DEFAULT matrix to keep routine runs cheap. Opus is
// ~63% of a run's LLM cost (premium output rate) and Sonnet already validates
// the Anthropic path — so Opus is opt-in: run it only when you specifically
// need it (BENCH_ONLY_MODEL=opus-4-7, or BENCH_ALL=1 to include everything).
const DEFAULT_EXCLUDED = new Set(["opus-4-7"]);

async function main() {
    loadConfig();
    const models = loadTier0Models();
    const prs = loadPRs();
    const onlyModel = process.env.BENCH_ONLY_MODEL; // smoke a single model slug
    const includeAll = process.env.BENCH_ALL === "1";
    const selected = onlyModel
        ? models.filter((m) => m.slug === onlyModel)
        : models.filter((m) => includeAll || !DEFAULT_EXCLUDED.has(m.slug));

    // Parallel (per-model tenant+repos) when the isolated repos exist, unless
    // BENCH_PARALLEL=0 forces the shared sequential path.
    const parallel = process.env.BENCH_PARALLEL !== "0" && (await isolatedReposReady(selected, prs));
    log.info(`Benchmark: ${selected.length} model(s) × ${prs.length} PRs on QA (${QA.webBaseUrl}) — ${parallel ? "PARALLEL (isolated tenant+repos)" : "sequential (shared tenant)"}`);

    const allResults: unknown[] = [];
    let totalOk = 0, totalFail = 0;
    if (parallel) {
        const outcomes = await Promise.all(
            selected.map((m) =>
                runModelIsolated(m, prs).catch((err): ModelOutcome => {
                    log.err(`${m.slug}: ${(err as Error).message}`);
                    return { ok: 0, fail: prs.length, results: prs.map((p) => ({ model: m.slug, repo: `${p.repo}-${m.slug}`, head: p.head, error: (err as Error).message })) };
                }),
            ),
        );
        for (const o of outcomes) { totalOk += o.ok; totalFail += o.fail; allResults.push(...o.results); }
    } else {
        const session = await getSession();
        log.ok(`benchmark tenant ready (team ${session.teamId})`);
        await ensureReviewLicense(session, selected[0]);
        await ensureOnboarded(session, prs.map((p) => p.repo));
        for (const model of selected) {
            const o = await runModelShared(model, session, prs);
            totalOk += o.ok; totalFail += o.fail; allResults.push(...o.results);
        }
    }

    const outPath = join(process.cwd(), "benchmark", "results.json");
    writeFileSync(outPath, JSON.stringify({ ranAt: new Date().toISOString(), models: selected.map((m) => m.slug), results: allResults }, null, 2));
    log.info(`RESULT: ${totalOk} reviewed, ${totalFail} failed (of ${selected.length * prs.length}). → ${outPath}`);
    // Tolerate a small number of residual failures (i.e. that survived the
    // per-PR retry) so a single transient model/provider error doesn't red the
    // whole 25-review run. A genuine model regression fails many PRs and still
    // trips the gate. Tolerated failures are logged loudly per-PR above (and
    // listed in results.json) — never silently swallowed. Tune via
    // BENCH_MAX_FAILURES (default 1; set 0 for strict).
    const maxFail = Math.max(0, Number(process.env.BENCH_MAX_FAILURES ?? 1));
    if (totalFail > maxFail) {
        log.err(`gate FAILED: ${totalFail} review failure(s) exceed BENCH_MAX_FAILURES=${maxFail}`);
        process.exit(1);
    }
    if (totalFail > 0) {
        log.info(`gate PASSED with ${totalFail} tolerated failure(s) (<= BENCH_MAX_FAILURES=${maxFail}) — investigate if recurring`);
    }
}

main().catch((e) => { log.err(String(e?.stack ?? e)); process.exit(1); });

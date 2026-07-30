import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { http } from "../lib/http.js";
import { login, signUp } from "../lib/onboarding.js";
import { pollUntil } from "../providers/base.js";
import {
    deepIncludesString,
    httpRetryTransient,
    disable,
    getStatus,
    init,
    mintTeamKey,
    revokeTeamKeyByName,
    selectRepoByFullName,
    sync,
} from "../lib/centralized-config.js";
import {
    ghClosePR,
    ghDeleteFile,
    ghGetPRState,
    ghListOpenPRs,
    ghMergeChange,
    ghMergePRNumber,
    ghPutFile,
    ghWaitFileContains,
    ghWaitFileGone,
} from "../lib/gh-contents.js";
import type { KodusSession, RunContext, Scenario, TargetContext } from "../lib/types.js";

// ---------------------------------------------------------------------------
// Centralized Config (config-as-code) — COMPREHENSIVE end-to-end.
//
// Exercises the whole mechanism against a real target, driving the SOURCE
// repo's state from the test itself (GitHub contents API), so every run is
// deterministic regardless of what a previous run left behind:
//
//   1. Lifecycle: status(off) → init(manual) → status(on) → re-init rejected.
//   2. Scope hierarchy: global + repository + directory kodus-config.yml files
//      (the repo-scope folder is the SOURCE REPO ITSELF — using a review
//      fixture repo like tiny-url here would re-register its webhook and
//      steal events from concurrently running matrix tenants).
//   3. Rules + memories: .kody-rules/review/ + .kody-rules/memories/ at global
//      scope, plus a repo-scoped review rule.
//   4. Update semantics: changed file values replace old ones (no duplicates).
//   5. Stale removal: deleting files removes the corresponding config scope
//      and rule on the next sync, leaving everything else intact.
//   6. Auto-sync on merge: a change landed through a real merged PR — with NO
//      manual sync call — propagates via the pull-request.closed listener
//      (the production trigger path).
//   7. PENDING mutation flow: while centralized is ON, creating a rule via
//      the API must NOT land directly — Kodus opens a PR on the source repo
//      and only the merge makes it active; deletion mirrors it
//      (create→PR→merge→active, delete→PR→merge→gone).
//   8. init(syncOption=pr): Kodus opens the initialization PR with the
//      current settings; the scenario asserts it exists and closes it.
//   9. disable → status(off).
//
// FULLY ISOLATED: signs up its own throwaway org (enabling centralized config
// makes a tenant's review config read-only and writes org-global config — a
// shared review tenant must never be subjected to that).
//
// Requires CENTRALIZED_CONFIG_TEST_REPO (owner/name) to point at a repo the
// GH_TEST_TOKEN PAT can WRITE to (it seeds/updates/deletes files and merges
// PRs there). Skips cleanly when unset.
//
// Out of scope (deliberate): review-time effect of synced rules — that is
// kody-rules-create-and-apply's job and needs a full LLM review round.
// ---------------------------------------------------------------------------

const PASSWORD = "E2eCentralized!2026x";

// Stable titles (identity across runs); per-run markers in the rule BODY so
// update semantics are assertable without fighting title-based identity.
const RULE_GLOBAL_TITLE = "e2e-centralized-rule-global";
const RULE_REPO_TITLE = "e2e-centralized-rule-repo";
const MEMORY_TITLE = "e2e-centralized-memory-global";

function configYml(sentinel: string): string {
    return [
        "# E2E centralized-config fixture — written by centralized-config-sync.",
        "# The sentinel ignorePath matches nothing real; it only proves THIS",
        "# file's content reached the synced code_review_config parameter.",
        "version: '1.2'",
        "ignorePaths:",
        "    - 'yarn.lock'",
        `    - '${sentinel}'`,
        "",
    ].join("\n");
}

function ruleYml(title: string, marker: string): string {
    return [
        "# E2E centralized-config fixture rule (scope value must be the",
        "# hyphenated enum form — see KodyRulesScope).",
        `title: ${title}`,
        "severity: medium",
        "scope: pull-request",
        "path: '**/*'",
        "rule: |",
        `    E2E fixture rule. Body marker: ${marker}. Flag the literal string`,
        "    __kodus_e2e_centralized_marker__ anywhere in the diff.",
        "",
    ].join("\n");
}

function memoryYml(title: string, marker: string): string {
    return [
        `title: ${title}`,
        "rule: |",
        `    E2E fixture memory. Body marker: ${marker}. The team prefers`,
        "    explicit error handling over silent fallbacks.",
        "",
    ].join("\n");
}

// Defensive walk of /kody-rules/find-by-organization-id: collect every object
// carrying BOTH a title and a status, so assertions can distinguish "active"
// from "soft-deleted but still serialized" without pinning the exact response
// nesting (same approach as kody-rules.ts findRuleStatusById).
function collectRuleEntries(
    node: unknown,
    out: Array<{
        title: string;
        status: string;
        uuid?: string;
        centralizedStatus?: string;
    }> = [],
): Array<{
    title: string;
    status: string;
    uuid?: string;
    centralizedStatus?: string;
}> {
    if (Array.isArray(node)) {
        for (const item of node) collectRuleEntries(item, out);
        return out;
    }
    if (node && typeof node === "object") {
        const obj = node as Record<string, unknown>;
        if (typeof obj.title === "string" && typeof obj.status === "string") {
            const cc = obj.centralizedConfig as { status?: unknown } | undefined;
            out.push({
                title: obj.title,
                status: obj.status,
                uuid: typeof obj.uuid === "string" ? obj.uuid : undefined,
                centralizedStatus:
                    typeof cc?.status === "string" ? cc.status : undefined,
            });
        }
        for (const v of Object.values(obj)) collectRuleEntries(v, out);
    }
    return out;
}

async function fetchCodeReviewConfig(
    target: TargetContext,
    session: KodusSession,
): Promise<unknown> {
    const resp = await http(
        `${target.apiBaseUrl}/parameters/find-by-key?key=code_review_config&teamId=${encodeURIComponent(session.teamId)}`,
        {
            headers: { Authorization: `Bearer ${session.accessToken}` },
            timeoutMs: 20_000,
        },
    );
    return resp.body;
}

async function fetchRules(
    target: TargetContext,
    session: KodusSession,
): Promise<unknown> {
    const resp = await http(
        `${target.apiBaseUrl}/kody-rules/find-by-organization-id`,
        {
            headers: { Authorization: `Bearer ${session.accessToken}` },
            timeoutMs: 20_000,
        },
    );
    return resp.body;
}

function activeTitles(rulesBody: unknown): Set<string> {
    return new Set(
        collectRuleEntries(rulesBody)
            .filter((r) => r.status === "active")
            .map((r) => r.title),
    );
}

export const centralizedConfigSync: Scenario = {
    id: "centralized-config-sync",
    title:
        "Centralized config: scopes, rules+memories, update, stale removal, merge-trigger, init-PR",
    priority: "P1",
    appliesTo: {
        target: ["cloud", "self-hosted"],
        provider: ["github"],
        license: ["paid", "license-paid"],
    },
    timeoutSec: 1200,
    async run(ctx: RunContext) {
        // Per-target source repo, same convention as resolveTargetRepo
        // (GH_TEST_REPO_CLOUD etc.): cloud and self-hosted cells run in
        // parallel in one matrix process, and this scenario WRITES to the
        // source repo — sharing one repo would let run A's global config be
        // overwritten by run B between A's seed and A's sync, and the
        // merge-trigger webhook would route to whichever run's org is
        // freshest. One repo per target removes both races. Skip (not
        // throw) when unset so cells without the fixture record `skipped`.
        const sfx = ctx.target.target.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
        const sourceRepoFullName =
            process.env[`CENTRALIZED_CONFIG_TEST_REPO_${sfx}`] ||
            process.env.CENTRALIZED_CONFIG_TEST_REPO;
        if (!sourceRepoFullName) {
            ctx.skip(
                `CENTRALIZED_CONFIG_TEST_REPO_${sfx} / CENTRALIZED_CONFIG_TEST_REPO are unset — no writable centralized-config source repo to drive`,
            );
        }
        const repoFolder = sourceRepoFullName!.split("/")[1]; // repo-scope folder = the source repo itself
        const run8 = ctx.runId.slice(0, 8).replace(/[^a-zA-Z0-9]/g, "");
        const uniq = `${run8}${Date.now().toString(36).slice(-4)}`;
        const sent = (tag: string) => `**/__e2e_${tag}_${uniq}__/**`;

        // Per-run sentinels (config) and body markers (rules).
        const G1 = sent("global_v1");
        const G2 = sent("global_v2");
        const G3 = sent("global_v3");
        const R1 = sent("repo_v1");
        const D1 = sent("dir_v1");
        // Distinct namespaces per artifact: the memory is deliberately NOT
        // touched by the update phase, so its marker must never collide with
        // the rule markers the phase-3 absence assertion checks.
        const RM1 = `grule-marker-${uniq}-v1`;
        const RM2 = `grule-marker-${uniq}-v2`;
        const MEM1 = `gmem-marker-${uniq}-v1`;
        const RRM1 = `rrule-marker-${uniq}-v1`; // repo rule is never updated — own namespace

        const FILES = {
            global: "kodus-config.yml",
            repo: `${repoFolder}/kodus-config.yml`,
            dir: `${repoFolder}/src/kodus-config.yml`,
            ruleGlobal: ".kody-rules/review/e2e-centralized-rule-global.yml",
            memoryGlobal: ".kody-rules/memories/e2e-centralized-memory.yml",
            ruleRepo: `${repoFolder}/.kody-rules/review/e2e-centralized-rule-repo.yml`,
        } as const;

        // ------------------------------------------------------------------
        // Phase 0 — throwaway org + integration + source repo + team key.
        // ------------------------------------------------------------------
        const email = `e2e-centralized-${Date.now()}@kodus.local`;
        await signUp(ctx.target, { email, password: PASSWORD });
        const session = await login(ctx.target, { email, password: PASSWORD });
        await ctx.kodus.registerIntegration(session);
        const sourceRepo = await selectRepoByFullName(
            ctx.target,
            session,
            sourceRepoFullName!,
        );
        const keyName = `e2e-centralized-${run8}`;
        const teamKey = await mintTeamKey(ctx.target, session, keyName);

        const evidence: Record<string, unknown> = {
            sourceRepo: sourceRepo.full_name,
            uniq,
        };
        let initPrNumber: number | undefined;

        try {
            // --------------------------------------------------------------
            // Phase 1 — lifecycle: off → init(manual) → on → re-init rejected.
            // --------------------------------------------------------------
            const before = await getStatus(ctx.target, teamKey);
            ctx.assert(
                before.enabled === false,
                `Expected centralized config disabled on a fresh org, got ${JSON.stringify(before)}`,
            );
            const initRes = await init(
                ctx.target,
                teamKey,
                String(sourceRepo.id),
                "manual",
            );
            ctx.assert(initRes.success, `init(manual) failed: ${JSON.stringify(initRes)}`);
            const afterInit = await getStatus(ctx.target, teamKey);
            ctx.assert(
                afterInit.enabled === true &&
                    String(afterInit.repository?.id) === String(sourceRepo.id),
                `Status after init mismatch: ${JSON.stringify(afterInit)}`,
            );
            // Idempotency: a second init while enabled must be rejected.
            const reInit = await init(
                ctx.target,
                teamKey,
                String(sourceRepo.id),
                "manual",
            );
            ctx.assert(
                reInit.success === false,
                `Second init while enabled should be rejected, got ${JSON.stringify(reInit)}`,
            );

            // --------------------------------------------------------------
            // Phase 2 — seed state v1 (all scopes + rules + memory), sync #1.
            // Pre-flight: close any open PR left by a previous run that died
            // mid-phase (the pending-flow PR detection below relies on "the
            // newest open PR is ours").
            // --------------------------------------------------------------
            for (const stale of await ghListOpenPRs(sourceRepoFullName!)) {
                try {
                    await ghClosePR(sourceRepoFullName!, stale.number);
                } catch {
                    /* best effort */
                }
            }
            await ghPutFile(sourceRepoFullName!, FILES.global, configYml(G1), `e2e ${uniq}: seed global config`);
            await ghPutFile(sourceRepoFullName!, FILES.repo, configYml(R1), `e2e ${uniq}: seed repo-scope config`);
            await ghPutFile(sourceRepoFullName!, FILES.dir, configYml(D1), `e2e ${uniq}: seed dir-scope config`);
            await ghPutFile(sourceRepoFullName!, FILES.ruleGlobal, ruleYml(RULE_GLOBAL_TITLE, RM1), `e2e ${uniq}: seed global rule`);
            await ghPutFile(sourceRepoFullName!, FILES.memoryGlobal, memoryYml(MEMORY_TITLE, MEM1), `e2e ${uniq}: seed memory`);
            await ghPutFile(sourceRepoFullName!, FILES.ruleRepo, ruleYml(RULE_REPO_TITLE, RRM1), `e2e ${uniq}: seed repo rule`);

            // Read-your-writes: don't ask Kodus to sync until GitHub serves
            // the seeded content back — a lagging tree read would make the
            // sync legitimately import stale state and fail the assertions.
            await ghWaitFileContains(sourceRepoFullName!, FILES.global, G1);
            await ghWaitFileContains(sourceRepoFullName!, FILES.repo, R1);
            await ghWaitFileContains(sourceRepoFullName!, FILES.dir, D1);
            await ghWaitFileContains(sourceRepoFullName!, FILES.ruleGlobal, RM1);
            await ghWaitFileContains(sourceRepoFullName!, FILES.memoryGlobal, MEM1);
            await ghWaitFileContains(sourceRepoFullName!, FILES.ruleRepo, RRM1);

            const sync1 = await sync(ctx.target, teamKey);
            ctx.assert(sync1.success, `sync #1 failed: ${JSON.stringify(sync1)}`);

            const cfg1 = await pollUntil<unknown>(
                async () => {
                    const body = await fetchCodeReviewConfig(ctx.target, session);
                    return deepIncludesString(body, G1) &&
                        deepIncludesString(body, R1) &&
                        deepIncludesString(body, D1)
                        ? body
                        : null;
                },
                { intervalSec: 3, timeoutSec: 60 },
            );
            ctx.assert(
                cfg1,
                `sync #1: global/repo/dir sentinels (${G1}, ${R1}, ${D1}) did not all appear in code_review_config within 60s — scope hierarchy sync broken`,
            );

            const rules1 = await pollUntil<unknown>(
                async () => {
                    const body = await fetchRules(ctx.target, session);
                    const titles = activeTitles(body);
                    return titles.has(RULE_GLOBAL_TITLE) &&
                        titles.has(RULE_REPO_TITLE) &&
                        deepIncludesString(body, MEMORY_TITLE) &&
                        deepIncludesString(body, RM1)
                        ? body
                        : null;
                },
                { intervalSec: 3, timeoutSec: 60 },
            );
            ctx.assert(
                rules1,
                `sync #1: expected active rules "${RULE_GLOBAL_TITLE}" + "${RULE_REPO_TITLE}", memory "${MEMORY_TITLE}", and body marker ${RM1} within 60s — rules/memories sync broken`,
            );
            evidence.sync1 = "global+repo+dir configs, 2 rules, 1 memory";

            // --------------------------------------------------------------
            // Phase 3 — update: global G1→G2, rule body M1→M2, sync #2.
            // --------------------------------------------------------------
            await ghPutFile(sourceRepoFullName!, FILES.global, configYml(G2), `e2e ${uniq}: update global config`);
            await ghPutFile(sourceRepoFullName!, FILES.ruleGlobal, ruleYml(RULE_GLOBAL_TITLE, RM2), `e2e ${uniq}: update global rule`);
            await ghWaitFileContains(sourceRepoFullName!, FILES.global, G2);
            await ghWaitFileContains(sourceRepoFullName!, FILES.ruleGlobal, RM2);
            const sync2 = await sync(ctx.target, teamKey);
            ctx.assert(sync2.success, `sync #2 failed: ${JSON.stringify(sync2)}`);

            const updated = await pollUntil<boolean>(
                async () => {
                    const cfg = await fetchCodeReviewConfig(ctx.target, session);
                    const rules = await fetchRules(ctx.target, session);
                    const cfgOk =
                        deepIncludesString(cfg, G2) &&
                        !deepIncludesString(cfg, G1) &&
                        deepIncludesString(cfg, R1) && // untouched scopes survive
                        deepIncludesString(cfg, D1);
                    const rulesOk =
                        deepIncludesString(rules, RM2) &&
                        !deepIncludesString(rules, RM1);
                    return cfgOk && rulesOk ? true : null;
                },
                { intervalSec: 3, timeoutSec: 60 },
            );
            ctx.assert(
                updated,
                `sync #2: update semantics broken — expected global ${G2} (not ${G1}), rule marker ${RM2} (not ${RM1}), repo/dir scopes untouched`,
            );
            evidence.sync2 = "update replaced old values, no duplicates";

            // --------------------------------------------------------------
            // Phase 4 — stale removal: delete dir config + repo rule, sync #3.
            // --------------------------------------------------------------
            await ghDeleteFile(sourceRepoFullName!, FILES.dir, `e2e ${uniq}: remove dir-scope config`);
            await ghDeleteFile(sourceRepoFullName!, FILES.ruleRepo, `e2e ${uniq}: remove repo rule`);
            await ghWaitFileGone(sourceRepoFullName!, FILES.dir);
            await ghWaitFileGone(sourceRepoFullName!, FILES.ruleRepo);
            const sync3 = await sync(ctx.target, teamKey);
            ctx.assert(sync3.success, `sync #3 failed: ${JSON.stringify(sync3)}`);

            const pruned = await pollUntil<boolean>(
                async () => {
                    const cfg = await fetchCodeReviewConfig(ctx.target, session);
                    const rules = await fetchRules(ctx.target, session);
                    const titles = activeTitles(rules);
                    const cfgOk =
                        !deepIncludesString(cfg, D1) && // dir scope pruned
                        deepIncludesString(cfg, G2) && // global survives
                        deepIncludesString(cfg, R1); // repo scope survives
                    const rulesOk =
                        !titles.has(RULE_REPO_TITLE) && // repo rule pruned
                        titles.has(RULE_GLOBAL_TITLE); // global rule survives
                    return cfgOk && rulesOk ? true : null;
                },
                { intervalSec: 3, timeoutSec: 60 },
            );
            ctx.assert(
                pruned,
                `sync #3: stale removal broken — dir sentinel ${D1} and rule "${RULE_REPO_TITLE}" should be gone; global ${G2} + repo ${R1} + "${RULE_GLOBAL_TITLE}" should survive`,
            );
            evidence.sync3 = "stale dir config + repo rule pruned, rest survived";

            // --------------------------------------------------------------
            // Phase 5 — auto-sync on merge: land G2→G3 via a real merged PR,
            // NO manual sync call. The pull-request.closed listener must pick
            // it up. Generous budget: webhook delivery + listener + sync.
            // --------------------------------------------------------------
            // A single GitHub webhook delivery can genuinely get lost — that
            // is a transient infrastructure event, not a Kodus regression.
            // One retry with a SECOND merged PR separates the two: a lost
            // delivery passes on the retry; a broken listener fails both.
            const mergeStart = Date.now();
            const waitAutoSync = (needle: string) =>
                pollUntil<boolean>(
                    async () => {
                        const cfg = await fetchCodeReviewConfig(
                            ctx.target,
                            session,
                        );
                        return deepIncludesString(cfg, needle) ? true : null;
                    },
                    { intervalSec: 5, timeoutSec: 180 },
                );
            const merged = await ghMergeChange(
                sourceRepoFullName!,
                [{ path: FILES.global, content: configYml(G3) }],
                `e2e ${uniq}: merge-trigger global config v3`,
            );
            evidence.mergeTriggerPr = merged.prNumber;
            let autoSynced = await waitAutoSync(G3);
            if (!autoSynced) {
                const G3b = sent("global_v3retry");
                const retryMerged = await ghMergeChange(
                    sourceRepoFullName!,
                    [{ path: FILES.global, content: configYml(G3b) }],
                    `e2e ${uniq}: merge-trigger retry (first delivery lost?)`,
                );
                evidence.mergeTriggerRetryPr = retryMerged.prNumber;
                autoSynced = await waitAutoSync(G3b);
            }
            ctx.assert(
                autoSynced,
                `Auto-sync on merge did not propagate even after a retry merge (PRs #${merged.prNumber}${evidence.mergeTriggerRetryPr ? ` + #${evidence.mergeTriggerRetryPr}` : ""}). Two consecutive lost deliveries are implausible — the pull-request.closed centralized-config listener (or webhook→org routing) is broken.`,
            );
            evidence.mergeTriggerLatencySec = Math.round(
                (Date.now() - mergeStart) / 1000,
            );

            // --------------------------------------------------------------
            // Phase 6 — PENDING flow: while centralized is ON, a rule
            // mutation via the API must NOT land directly — Kodus opens a PR
            // on the source repo and parks the rule as pending; merging the
            // PR is what makes it active (and deletion mirrors it).
            // --------------------------------------------------------------
            const pendingTitle = `e2e-pending-rule-${uniq}`;
            const createResp = await httpRetryTransient(
                `${ctx.target.apiBaseUrl}/kody-rules/create-or-update`,
                {
                    method: "POST",
                    headers: { Authorization: `Bearer ${session.accessToken}` },
                    body: {
                        teamId: session.teamId,
                        repositoryId: String(sourceRepo.id),
                        type: "standard",
                        title: pendingTitle,
                        rule: `E2E pending-flow rule (${uniq}): created via API while centralized config is enabled; must arrive through a merged PR, never directly.`,
                        severity: "medium",
                        origin: "manual",
                        path: "",
                    },
                    timeoutMs: 60_000,
                },
            );
            ctx.assert(
                createResp.status >= 200 && createResp.status < 300,
                `create-or-update (pending flow) failed: HTTP ${createResp.status} ${createResp.raw.slice(0, 200)}`,
            );
            // The rule must be parked as pending_add (its lifecycle `status`
            // flips to active immediately — the review-exclusion gate keys
            // off centralizedConfig.status, observed live on QA)…
            const rulesAfterCreate = await fetchRules(ctx.target, session);
            const createdEntry = collectRuleEntries(rulesAfterCreate).find(
                (r) => r.title === pendingTitle,
            );
            ctx.assert(
                createdEntry?.centralizedStatus === "pending_add",
                `Pending flow broken: rule "${pendingTitle}" should carry centralizedConfig.status=pending_add right after creation, got ${JSON.stringify(createdEntry)}`,
            );
            // …and a PR must exist on the source repo carrying it.
            const mutationPr = await pollUntil<{ number: number }>(
                async () => {
                    const open = await ghListOpenPRs(sourceRepoFullName!);
                    return open.find((p) => /kody rule/i.test(p.title)) ?? null;
                },
                { intervalSec: 3, timeoutSec: 45 },
            );
            ctx.assert(
                mutationPr,
                `Pending flow broken: no PR was opened on ${sourceRepoFullName} for the rule mutation within 45s`,
            );
            evidence.pendingCreatePr = mutationPr!.number;
            await ghMergePRNumber(sourceRepoFullName!, mutationPr!.number);
            const pendingSynced = await pollUntil<boolean>(
                async () => {
                    const rules = await fetchRules(ctx.target, session);
                    const entry = collectRuleEntries(rules).find(
                        (r) => r.title === pendingTitle,
                    );
                    return entry?.centralizedStatus === "synced" &&
                        entry.status === "active"
                        ? true
                        : null;
                },
                { intervalSec: 5, timeoutSec: 240 },
            );
            ctx.assert(
                pendingSynced,
                `Pending flow broken: rule "${pendingTitle}" did not transition to centralizedStatus=synced within 240s of merging its PR #${mutationPr!.number}`,
            );

            // Deletion mirrors it: API delete → PR → merge → rule gone.
            const ruleUuid = collectRuleEntries(
                await fetchRules(ctx.target, session),
            ).find((r) => r.title === pendingTitle)?.uuid;
            ctx.assert(
                ruleUuid,
                `Could not resolve uuid for "${pendingTitle}" after it became active`,
            );
            const delResp = await httpRetryTransient(
                `${ctx.target.apiBaseUrl}/kody-rules/delete-rule-in-organization-by-id?ruleId=${encodeURIComponent(ruleUuid!)}&teamId=${encodeURIComponent(session.teamId)}`,
                {
                    method: "DELETE",
                    headers: { Authorization: `Bearer ${session.accessToken}` },
                    timeoutMs: 60_000,
                },
            );
            ctx.assert(
                delResp.status >= 200 && delResp.status < 300,
                `delete (pending flow) failed: HTTP ${delResp.status} ${delResp.raw.slice(0, 200)}`,
            );
            const deletePr = await pollUntil<{ number: number }>(
                async () => {
                    const open = await ghListOpenPRs(sourceRepoFullName!);
                    return open.find((p) => /kody rule/i.test(p.title)) ?? null;
                },
                { intervalSec: 3, timeoutSec: 45 },
            );
            ctx.assert(
                deletePr,
                `Pending-delete flow broken: no PR opened on ${sourceRepoFullName} for the rule deletion within 45s`,
            );
            evidence.pendingDeletePr = deletePr!.number;
            await ghMergePRNumber(sourceRepoFullName!, deletePr!.number);
            const pendingGone = await pollUntil<boolean>(
                async () => {
                    const rules = await fetchRules(ctx.target, session);
                    return !activeTitles(rules).has(pendingTitle) ? true : null;
                },
                { intervalSec: 5, timeoutSec: 240 },
            );
            ctx.assert(
                pendingGone,
                `Pending-delete flow broken: rule "${pendingTitle}" still ACTIVE 240s after merging its deletion PR #${deletePr!.number}`,
            );
            evidence.pendingFlow = "create→PR→merge→active, delete→PR→merge→gone";

            // --------------------------------------------------------------
            // Phase 7 — init(syncOption=pr): disable, re-init in PR mode,
            // assert Kodus opened the initialization PR, close it.
            // --------------------------------------------------------------
            const disable1 = await disable(ctx.target, teamKey);
            ctx.assert(disable1.success, `disable (pre init-pr) failed: ${JSON.stringify(disable1)}`);
            const initPr = await init(
                ctx.target,
                teamKey,
                String(sourceRepo.id),
                "pr",
            );
            ctx.assert(
                initPr.success && initPr.prUrl,
                `init(pr) should succeed and return prUrl, got ${JSON.stringify(initPr)}`,
            );
            const prMatch = /\/pull\/(\d+)/.exec(initPr.prUrl ?? "");
            ctx.assert(
                prMatch,
                `init(pr) returned an unparseable prUrl: ${initPr.prUrl}`,
            );
            initPrNumber = Number(prMatch![1]);
            const prState = await ghGetPRState(sourceRepoFullName!, initPrNumber);
            ctx.assert(
                prState === "open",
                `init(pr) PR #${initPrNumber} should be open on ${sourceRepoFullName}, got state=${prState}`,
            );
            evidence.initPr = initPr.prUrl;

            // --------------------------------------------------------------
            // Phase 8 — disable → off.
            // --------------------------------------------------------------
            const disable2 = await disable(ctx.target, teamKey);
            ctx.assert(disable2.success, `final disable failed: ${JSON.stringify(disable2)}`);
            const afterDisable = await getStatus(ctx.target, teamKey);
            ctx.assert(
                afterDisable.enabled === false,
                `Expected enabled=false after disable, got ${JSON.stringify(afterDisable)}`,
            );

            writeFileSync(
                join(ctx.artifactDir, "centralized-config.json"),
                JSON.stringify(evidence, null, 2),
            );
            return evidence;
        } finally {
            // Best-effort teardown: centralized off, key revoked, init-PR
            // closed. Source-repo files are left in their end state — every
            // run rewrites them with fresh per-run sentinels, so leftovers
            // can never satisfy the next run's assertions.
            try {
                await disable(ctx.target, teamKey);
            } catch {
                /* best effort */
            }
            if (initPrNumber !== undefined) {
                try {
                    await ghClosePR(sourceRepoFullName!, initPrNumber);
                } catch {
                    /* best effort */
                }
            }
            await revokeTeamKeyByName(ctx.target, session, keyName);
            // Drop this org's code-management integration so it leaves the
            // source repo's webhook→org candidate pool. Throwaway orgs
            // accumulate one per run; without this, merge-trigger routing
            // ("most recently updated org wins") degrades over time as dead
            // orgs keep competing for deliveries.
            try {
                await http(
                    `${ctx.target.apiBaseUrl}/code-management/delete-integration?teamId=${encodeURIComponent(session.teamId)}`,
                    {
                        method: "DELETE",
                        headers: {
                            Authorization: `Bearer ${session.accessToken}`,
                        },
                        timeoutMs: 20_000,
                    },
                );
            } catch {
                /* best effort */
            }
        }
    },
};

export default centralizedConfigSync;

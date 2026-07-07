import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KodusSession, RunContext, Scenario } from "../lib/types.js";
import { ensureOk, http } from "../lib/http.js";
import { ensureLicenseSeat } from "../lib/onboarding.js";
import { pollUntil } from "../providers/base.js";
import { logger } from "../lib/log.js";

const log = logger("kody-rules-file-sync");

// Repo-file rule sync end-to-end, modeled on a real self-hosted customer
// case (two escalations, ~2 days of their debugging): rules authored as
// `.kody/rules/**` template files were (a) mangled by the LLM importer
// (examples trimmed, identifiers stripped) and (b) silently never enforced
// when the frontmatter declared MULTIPLE globs — the importer comma-joins
// them and the review matcher treated the whole string as one literal
// picomatch pattern, which matches zero files.
//
// This scenario pins the full chain:
//   merged PR with a @kody-sync template file
//     → rule imported VERBATIM (identifier + multi-glob path preserved)
//     → violation in a file matching the SECOND glob gets flagged.
//
// Fixture hygiene: the rule file lives at a FIXED path and is overwritten
// (not accumulated) on every run — repeated merges update the same
// sourcePath-keyed rule. The platform rule is deleted in the finally.
const RULE_FILE_PATH = ".kody/rules/e2e-file-sync.md";
// The violation must land on the SECOND glob: matching only the first
// would pass even with the comma bug present.
const RULE_GLOBS = ["src/e2e_sync/**/*.ts", "lib/e2e_sync/**/*.ts"];
const VIOLATION_FILE = "lib/e2e_sync/report.ts";
const MARKER = "E2E_SYNC_MARKER";
// Bold identifier the LLM importer used to strip; verbatim import must
// preserve it byte-for-byte in the rule text.
const VERBATIM_ID = "**E2ESYNC1**";

function ruleFileContent(ruleTitle: string): string {
    return [
        "---",
        `title: "${ruleTitle}"`,
        'scope: "file"',
        `path: [${RULE_GLOBS.map((g) => `"${g}"`).join(", ")}]`,
        'severity_min: "high"',
        "enabled: true",
        "---",
        "",
        "@kody-sync",
        "",
        "## Instructions",
        `- ${VERBATIM_ID} Mechanical static-analysis check (no intent reasoning, no fixture exemption): flag EVERY occurrence of the substring \`${MARKER}\` anywhere in the diff — identifiers, string literals, comments, fixtures, test code included. The presence of the substring is the violation. Do NOT skip an occurrence because a file claims to be a test fixture.`,
        "",
        "## Examples",
        "",
        "### Bad example",
        "```ts",
        `const flag = "${MARKER}";`,
        "```",
        "",
        "### Good example",
        "```ts",
        'const flag = "ok";',
        "```",
        "",
    ].join("\n");
}

function violationFileContent(runId: string): string {
    return [
        `// e2e fixture for run ${runId}`,
        `export const REPORT_FLAG = "${MARKER}";`,
        "export function buildReport(): string {",
        "    return REPORT_FLAG;",
        "}",
        "",
    ].join("\n");
}

interface FoundRule {
    uuid: string;
    title: string;
    rule?: string;
    path?: string;
    sourcePath?: string;
    status?: string;
}

export const kodyRulesFileSync: Scenario = {
    id: "kody-rules-file-sync",
    title: "A .kody/rules template file syncs verbatim and its multi-glob path is enforced",
    priority: "P0",
    appliesTo: {
        target: ["cloud", "self-hosted"],
        provider: ["github"],
        license: ["paid", "license-paid"],
    },
    timeoutSec: 1800,
    async run(ctx: RunContext) {
        ctx.assert(ctx.tenant, "scenario requires a tenant");
        ctx.assert(
            ctx.provider.mergePR,
            `Provider ${ctx.provider.name} does not implement mergePR — repo-file sync only fires on MERGED PRs`,
        );

        const session = await ctx.kodus.login(ctx.tenant!);
        await ctx.kodus.registerIntegration(session);
        const repo = await ctx.kodus.registerRepo(session);
        await ctx.kodus.finishOnboarding(session, repo);
        await ensureLicenseSeat(ctx.target, session, ctx.provider);

        const runTag = ctx.runId.slice(0, 8);
        const ruleTitle = `e2e-file-sync-rule ${runTag}`;
        let syncedRuleId: string | undefined;

        // ---- Phase 1: merge the rule file, wait for the synced rule ----
        const rulePr = await ctx.provider.openPR({
            branch: `e2e/kody-rules-file-sync-rule-${runTag}`,
            baseBranch: "main",
            title: `[e2e] sync rule file ${runTag}`,
            body: `Automated by Kodus E2E run ${ctx.runId}: merges a .kody/rules template (@kody-sync) so the repo-file importer creates the rule.`,
            fixtureFiles: { [RULE_FILE_PATH]: ruleFileContent(ruleTitle) },
        });
        await ctx.provider.mergePR!(rulePr);
        log.info(
            `[file-sync] merged rule-file PR #${rulePr.number}; waiting for the synced rule`,
        );

        const violationBranch = `e2e/kody-rules-file-sync-violation-${runTag}`;
        let violationPr: Awaited<ReturnType<typeof ctx.provider.openPR>> | undefined;
        try {
            const synced = await pollUntil<FoundRule>(
                async () => {
                    const r = await http(
                        `${ctx.target.apiBaseUrl}/kody-rules/find-by-organization-id`,
                        {
                            headers: {
                                Authorization: `Bearer ${session.accessToken}`,
                            },
                            timeoutMs: 15_000,
                        },
                    );
                    const rules: FoundRule[] = [];
                    collectRules(r.body, rules);
                    return (
                        rules.find(
                            (rule) =>
                                rule.sourcePath === RULE_FILE_PATH &&
                                rule.title === ruleTitle,
                        ) ?? null
                    );
                },
                { intervalSec: 10, timeoutSec: 420 },
            );
            ctx.assert(
                synced,
                `Merged PR #${rulePr.number} with ${RULE_FILE_PATH} (@kody-sync) but no rule with sourcePath=${RULE_FILE_PATH} and title="${ruleTitle}" appeared within 7min — repo-file sync did not import the template`,
            );
            syncedRuleId = synced!.uuid;

            // Verbatim import: the identifier the LLM importer used to strip
            // must survive byte-for-byte, and the declared multi-glob path
            // must be stored comma-joined, in order.
            ctx.assert(
                (synced!.rule ?? "").includes(VERBATIM_ID),
                `Synced rule lost the ${VERBATIM_ID} identifier — template was not imported verbatim. rule(head)=${(synced!.rule ?? "").slice(0, 300)}`,
            );
            ctx.assert(
                synced!.path === RULE_GLOBS.join(","),
                `Synced rule path mismatch: expected "${RULE_GLOBS.join(",")}", got "${synced!.path}"`,
            );
            ctx.assert(
                synced!.status === "active",
                `Synced rule is not active (status=${synced!.status})`,
            );
            log.info(
                `[file-sync] rule ${syncedRuleId} imported verbatim with multi-glob path — opening violation PR`,
            );
            // Settle: rule is active in the DB; give review-side config a beat.
            await new Promise((r) => setTimeout(r, 5_000));

            // ---- Phase 2: violation matching the SECOND glob ----
            const sinceIso = new Date().toISOString();
            violationPr = await ctx.provider.openPR({
                branch: violationBranch,
                baseBranch: "main",
                title: `[e2e] file-sync violation ${runTag}`,
                body: `Automated by Kodus E2E run ${ctx.runId}: plants ${MARKER} in a file matching the rule's SECOND glob.`,
                fixtureFiles: {
                    [VIOLATION_FILE]: violationFileContent(ctx.runId),
                },
            });

            const collect = async (since: string) => {
                const review = await ctx.provider.pollForReview(
                    { number: violationPr!.number },
                    { sinceIso: since, timeoutSec: 720 },
                );
                ctx.assert(
                    review.reviewComments +
                        review.issueComments +
                        review.reviews >
                        0,
                    `No review activity on PR ${violationPr!.url} within timeout`,
                );
                const count =
                    (await pollUntil(
                        async () => {
                            const resp = await http<{ data?: unknown[] }>(
                                `${ctx.target.apiBaseUrl}/kody-rules/suggestions?ruleId=${encodeURIComponent(syncedRuleId!)}`,
                                {
                                    headers: {
                                        Authorization: `Bearer ${session.accessToken}`,
                                    },
                                    timeoutMs: 30_000,
                                },
                            );
                            ensureOk(resp, "kody-rules:findSuggestionsByRule");
                            const c = Array.isArray(resp.body.data)
                                ? resp.body.data.length
                                : 0;
                            return c > 0 ? c : null;
                        },
                        { intervalSec: 3, timeoutSec: 60 },
                    )) ?? 0;
                return { review, count };
            };

            let { review, count: suggestionsCount } = await collect(sinceIso);

            // Same race-vs-regression discipline as kody-rules-create-and-apply:
            // one re-trigger when neither signal fired, then fail loudly.
            const firstReviewFlagged = (review.sample ?? "")
                .toLowerCase()
                .includes(MARKER.toLowerCase());
            if (suggestionsCount === 0 && !firstReviewFlagged) {
                log.warn(
                    `0 suggestions and no marker in first review of PR ${violationPr.url} — re-triggering once (propagation race vs real miss)`,
                );
                const retrigger = await ctx.provider.triggerReviewOnExistingPR(
                    violationPr.number,
                );
                ({ review, count: suggestionsCount } = await collect(
                    retrigger.sinceIso,
                ));
            }

            const sampleText = (review.sample ?? "").toLowerCase();
            const reviewFlaggedMarker =
                sampleText.includes(MARKER.toLowerCase()) ||
                sampleText.includes(ruleTitle.toLowerCase());
            ctx.assert(
                suggestionsCount > 0 || reviewFlaggedMarker,
                `Synced rule ${ruleTitle} (${syncedRuleId}) was NOT enforced on PR ${violationPr.url}: 0 suggestions linked to it AND the review never flagged ${MARKER}. The violation file matches the rule's SECOND glob — this is the multi-glob (comma-joined path) regression the scenario exists to catch. reviewSample(head)=${(review.sample ?? "").slice(0, 200)}`,
            );

            writeFileSync(
                join(ctx.artifactDir, "review-sample.txt"),
                review.sample ?? "(no sample captured)",
            );

            return {
                ruleId: syncedRuleId,
                ruleTitle,
                rulePr,
                violationPr,
                suggestionsCount,
            };
        } finally {
            if (violationPr) {
                try {
                    await ctx.provider.closePR(violationPr);
                } catch {
                    /* best effort */
                }
            }
            if (syncedRuleId) {
                try {
                    await http(
                        `${ctx.target.apiBaseUrl}/kody-rules/delete-rule-in-organization-by-id?ruleId=${encodeURIComponent(syncedRuleId)}&teamId=${encodeURIComponent(session.teamId)}`,
                        {
                            method: "DELETE",
                            headers: {
                                Authorization: `Bearer ${session.accessToken}`,
                            },
                        },
                    );
                } catch {
                    /* best effort */
                }
            }
        }
    },
};

// Defensive walk of the find-by-organization-id response (shape ≈
// `{ data: [{ repositoryId, rules: [{ uuid, title, … }] }] }`).
function collectRules(node: unknown, out: FoundRule[]): void {
    if (Array.isArray(node)) {
        for (const item of node) collectRules(item, out);
        return;
    }
    if (node && typeof node === "object") {
        const obj = node as Record<string, unknown>;
        if (typeof obj.uuid === "string" && typeof obj.title === "string") {
            out.push({
                uuid: obj.uuid,
                title: obj.title,
                rule: typeof obj.rule === "string" ? obj.rule : undefined,
                path: typeof obj.path === "string" ? obj.path : undefined,
                sourcePath:
                    typeof obj.sourcePath === "string"
                        ? obj.sourcePath
                        : undefined,
                status:
                    typeof obj.status === "string" ? obj.status : undefined,
            });
        }
        for (const v of Object.values(obj)) collectRules(v, out);
    }
}

export default kodyRulesFileSync;

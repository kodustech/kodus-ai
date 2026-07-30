import { randomUUID } from 'node:crypto';
import type { RunContext, Scenario } from '../lib/types.js';
import { http } from '../lib/http.js';
import { ensureLicenseSeat } from '../lib/onboarding.js';
import { pollUntil } from '../providers/base.js';
import { logger } from '../lib/log.js';

const log = logger('kody-rules-lifecycle');

// Full lifecycle of a repo-synced rule — add → fix → remove — with the
// assertions distilled from the bugs LIVE MANUAL VALIDATION caught after
// every automated scenario was already green:
//
//  * one merge created TWO identical rules (bridge double-instance + the
//    sync listener racing in multiple processes) → uniqueness assert;
//  * a sync error, once stamped, was IMMORTAL (clean re-detection skipped
//    the save, so the errored revision stayed latest) → self-clear assert;
//  * '@kody-sync' itself was reported as a missing file, and the LLM
//    detector contaminated real reference names with a fabricated
//    'kody-sync/' repo prefix → clean-error-content asserts;
//  * removing the rule file must remove the rule (the delete path had no
//    coverage anywhere) → removal assert.
//
// Fixture hygiene: fixed file path, overwritten per phase; the rule is
// deleted in the finally as a backstop even though phase 3 removes it.
const RULE_FILE_PATH = '.kody/rules/e2e-lifecycle.md';
const MISSING_REF = 'docs/e2e-lifecycle-missing.md';

function ruleFile(title: string, phase: 'broken-ref' | 'fixed'): string {
    const instructions =
        phase === 'broken-ref'
            ? `- The response shape is documented in \`${MISSING_REF}\` (deliberately nonexistent).`
            : '- Response shapes must stay consistent across endpoints. (references removed — PHASE2_FIXED)';
    return [
        '---',
        `title: "${title}"`,
        'scope: "file"',
        'path: ["src/**/*.ts"]',
        'severity_min: "medium"',
        'enabled: true',
        '---',
        '',
        '@kody-sync',
        '',
        '## Instructions',
        instructions,
        '',
    ].join('\n');
}

interface LifecycleRule {
    uuid: string;
    title: string;
    rule?: string;
    status?: string;
    sourcePath?: string;
    syncErrors?: Array<{
        message?: string;
        details?: { fileName?: string };
    }>;
}

export const kodyRulesLifecycle: Scenario = {
    id: 'kody-rules-lifecycle',
    title: 'Repo-synced rule lifecycle: unique import, self-clearing sync errors, removal on file delete',
    priority: 'P1',
    appliesTo: {
        target: ['cloud', 'self-hosted'],
        provider: ['github'],
        license: ['paid', 'license-paid'],
    },
    timeoutSec: 1800,
    async run(ctx: RunContext) {
        ctx.assert(ctx.tenant, 'scenario requires a tenant');
        ctx.assert(
            ctx.provider.mergePR,
            `Provider ${ctx.provider.name} does not implement mergePR — rule sync only fires on MERGED PRs`,
        );

        const session = await ctx.kodus.login(ctx.tenant!);
        await ctx.kodus.registerIntegration(session);
        const repo = await ctx.kodus.registerRepo(session);
        await ctx.kodus.finishOnboarding(session, repo);
        await ensureLicenseSeat(ctx.target, session, ctx.provider);

        const runTag = `${ctx.runId.slice(-6)}-${randomUUID().slice(0, 6)}`;
        const ruleTitle = `e2e-lifecycle-rule ${runTag}`;
        let ruleId: string | undefined;

        const findAll = async (): Promise<LifecycleRule[]> => {
            const r = await http(
                `${ctx.target.apiBaseUrl}/kody-rules/find-by-organization-id`,
                {
                    headers: { Authorization: `Bearer ${session.accessToken}` },
                    timeoutMs: 15_000,
                },
            );
            const rules: LifecycleRule[] = [];
            collect(r.body, rules);
            // The API can surface the same rule uuid through several
            // repo groupings — count DISTINCT uuids.
            const byUuid = new Map(rules.map((rule) => [rule.uuid, rule]));
            return [...byUuid.values()].filter(
                (rule) =>
                    rule.sourcePath === RULE_FILE_PATH &&
                    rule.title === ruleTitle &&
                    rule.status !== 'deleted',
            );
        };

        const mergeRuleFile = async (
            phase: string,
            content: Record<string, string>,
            deleteFiles?: string[],
        ) => {
            const pr = await ctx.provider.openPR({
                branch: `e2e/lifecycle-${phase}-${runTag}`,
                title: `[e2e] lifecycle ${phase} ${runTag}`,
                body: `Automated by Kodus E2E run ${ctx.runId} (lifecycle phase: ${phase}).`,
                fixtureFiles: content,
                deleteFiles,
            });
            await ctx.provider.mergePR!(pr);
            log.info(`[lifecycle] merged ${phase} PR #${pr.number}`);
            return pr;
        };

        try {
            // ---- Phase 1: import with a broken reference ----
            await mergeRuleFile('add', {
                [RULE_FILE_PATH]: ruleFile(ruleTitle, 'broken-ref'),
            });

            const imported = await pollUntil<LifecycleRule[]>(
                async () => {
                    const found = await findAll();
                    // Wait until the rule exists AND its reference detection
                    // settled (error stamped for the missing file).
                    return found.length > 0 &&
                        (found[0].syncErrors?.length ?? 0) > 0
                        ? found
                        : null;
                },
                { intervalSec: 10, timeoutSec: 420 },
            );
            ctx.assert(
                imported,
                `Rule from ${RULE_FILE_PATH} (with a broken reference) did not appear with a sync error within 7min`,
            );

            // Exactly ONE rule: the duplicate-import regression (multi-process
            // sync race) produced two identical rules from one merge.
            ctx.assert(
                imported!.length === 1,
                `Expected exactly 1 rule for ${RULE_FILE_PATH}, found ${imported!.length} — duplicate import regression (cross-process sync dedupe broken)`,
            );
            ruleId = imported![0].uuid;

            const errors = imported![0].syncErrors ?? [];
            const errorText = JSON.stringify(errors);
            ctx.assert(
                errors.some((e) => e.details?.fileName === MISSING_REF),
                `Sync error should name the missing file EXACTLY as "${MISSING_REF}" (no fabricated repo prefix). errors=${errorText.slice(0, 400)}`,
            );
            ctx.assert(
                !errorText.toLowerCase().includes('kody-sync'),
                `Sync errors must never mention the @kody-sync control marker (spurious-marker regression). errors=${errorText.slice(0, 400)}`,
            );
            log.info(
                `[lifecycle] rule ${ruleId} imported once, with a clean sync error — merging the fix`,
            );

            // ---- Phase 2: fix the reference → error must SELF-CLEAR ----
            await mergeRuleFile('fix', {
                [RULE_FILE_PATH]: ruleFile(ruleTitle, 'fixed'),
            });

            const cleared = await pollUntil<LifecycleRule>(
                async () => {
                    const found = await findAll();
                    const rule = found[0];
                    if (!rule) return null;
                    const updated = (rule.rule ?? '').includes('PHASE2_FIXED');
                    const clean = (rule.syncErrors?.length ?? 0) === 0;
                    return updated && clean ? rule : null;
                },
                { intervalSec: 10, timeoutSec: 420 },
            );
            ctx.assert(
                cleared,
                `After merging the fixed rule file, the rule did not reach updated-content + ZERO sync errors within 7min — the stale-sync-error (immortal error chip) regression`,
            );
            ctx.assert(
                (await findAll()).length === 1,
                'Rule count changed after the edit merge — updates must not duplicate',
            );
            log.info(
                `[lifecycle] stale error self-cleared on re-sync — merging the removal`,
            );

            // ---- Phase 3: delete the file → rule must be removed ----
            await mergeRuleFile('remove', {}, [RULE_FILE_PATH]);

            const removed = await pollUntil<boolean>(
                async () => ((await findAll()).length === 0 ? true : null),
                { intervalSec: 10, timeoutSec: 420 },
            );
            ctx.assert(
                removed,
                `Rule file was deleted on the default branch but the rule is still present after 7min — file-removal → rule-removal path broken`,
            );

            return { ruleId, ruleTitle };
        } finally {
            if (ruleId) {
                try {
                    await http(
                        `${ctx.target.apiBaseUrl}/kody-rules/delete-rule-in-organization-by-id?ruleId=${encodeURIComponent(ruleId)}&teamId=${encodeURIComponent(session.teamId)}`,
                        {
                            method: 'DELETE',
                            headers: {
                                Authorization: `Bearer ${session.accessToken}`,
                            },
                        },
                    );
                } catch {
                    /* best effort — phase 3 normally removes it */
                }
            }
        }
    },
};

function collect(node: unknown, out: LifecycleRule[]): void {
    if (Array.isArray(node)) {
        for (const item of node) collect(item, out);
        return;
    }
    if (node && typeof node === 'object') {
        const obj = node as Record<string, unknown>;
        if (typeof obj.uuid === 'string' && typeof obj.title === 'string') {
            out.push({
                uuid: obj.uuid,
                title: obj.title,
                rule: typeof obj.rule === 'string' ? obj.rule : undefined,
                status: typeof obj.status === 'string' ? obj.status : undefined,
                sourcePath:
                    typeof obj.sourcePath === 'string'
                        ? obj.sourcePath
                        : undefined,
                syncErrors: Array.isArray(obj.syncErrors)
                    ? (obj.syncErrors as LifecycleRule['syncErrors'])
                    : undefined,
            });
        }
        for (const v of Object.values(obj)) collect(v, out);
    }
}

export default kodyRulesLifecycle;

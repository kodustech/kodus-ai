import { randomUUID } from 'node:crypto';
import type { RunContext, Scenario } from '../lib/types.js';
import { http } from '../lib/http.js';
import { ensureLicenseSeat } from '../lib/onboarding.js';
import { pollUntil } from '../providers/base.js';
import { logger } from '../lib/log.js';

const log = logger('rule-file-detection');

// Rule-FILE detection semantics (#1484/#1485), split from
// kody-rules-file-sync on purpose: this one has NO review step — one merged
// PR plus API polling — so it stays cheap enough to run in every matrix
// tier. It pins three detection behaviors that silently failed before the
// hotfix:
//   1. Root AGENTS.md (uppercase, no leading dot) is imported at all —
//      the pattern list only had the .agents.md dotfiles.
//   2. A nested guidance file (services/x/CLAUDE.md) is discovered without
//      per-directory configuration AND its rule is scoped to that subdir.
//   3. Matching is case-insensitive (a lowercase claude.md in a subdir).
//
// Content assertions are deliberately structural (rule exists, sourcePath,
// path scoping) — these files go through the LLM importer, so exact-text
// assertions would be flaky. Files are FIXED paths overwritten per run; the
// imported rules are deleted in the finally.
const INLINE_TOKEN = 'E2E_INLINE_TOKEN_7743';
// docs/e2e-conventions.md is the @-reference TARGET, not a rule source.
const RULE_SOURCES = [
    'AGENTS.md',
    'services/billing/CLAUDE.md',
    'packages/ui/claude.md',
];

const FILES: Record<string, { content: (tag: string) => string }> = {
    'AGENTS.md': {
        // Single-section fixture ON PURPOSE: the @-reference (and its
        // inlined token) must be the DOMINANT content so extraction can't
        // legitimately drop it — a weaker model split the earlier
        // two-section version and kept only the sibling section.
        content: (tag) =>
            [
                `<!-- e2e rule-file-detection ${tag} -->`,
                '# API convention enforcement',
                '',
                '- Enforce the API conventions described in @docs/e2e-conventions.md on every changed endpoint.',
                '- The convention identifier from that document MUST be quoted verbatim in the rule.',
            ].join('\n'),
    },
    // Target of the @-reference above: the customer reported @AGENTS.md-style
    // references being silently dropped; the importer must INLINE this file's
    // content (the INLINE_TOKEN below) into the AGENTS.md rule text.
    'docs/e2e-conventions.md': {
        content: (tag) =>
            [
                `<!-- e2e rule-file-detection ${tag} -->`,
                '# API conventions',
                '',
                `- Every endpoint must set the X-E2E-Convention header (${INLINE_TOKEN}).`,
            ].join('\n'),
    },
    'services/billing/CLAUDE.md': {
        content: (tag) =>
            [
                `<!-- e2e rule-file-detection ${tag} -->`,
                '# Billing service guidance',
                '',
                '- All monetary amounts must use integer cents, never floats.',
                '- Every mutation to invoices must be idempotent.',
            ].join('\n'),
    },
    'packages/ui/claude.md': {
        content: (tag) =>
            [
                `<!-- e2e rule-file-detection ${tag} -->`,
                '# UI package guidance (lowercase filename on purpose)',
                '',
                '- Components must not import from app-level modules.',
            ].join('\n'),
    },
};

interface FoundRule {
    uuid: string;
    title: string;
    rule?: string;
    path?: string;
    sourcePath?: string;
    status?: string;
}

export const ruleFileDetection: Scenario = {
    id: 'rule-file-detection',
    title: 'AGENTS.md, nested and lowercase guidance files are detected and scoped',
    priority: 'P1',
    appliesTo: {
        target: ['cloud', 'self-hosted'],
        provider: ['github'],
        license: ['paid', 'license-paid'],
    },
    timeoutSec: 1200,
    async run(ctx: RunContext) {
        ctx.assert(ctx.tenant, 'scenario requires a tenant');
        ctx.assert(
            ctx.provider.mergePR,
            `Provider ${ctx.provider.name} does not implement mergePR — repo-file sync only fires on MERGED PRs`,
        );

        const session = await ctx.kodus.login(ctx.tenant!);
        await ctx.kodus.registerIntegration(session);
        const repo = await ctx.kodus.registerRepo(session);
        await ctx.kodus.finishOnboarding(session, repo);
        await ensureLicenseSeat(ctx.target, session, ctx.provider);

        const runTag = `${ctx.runId.slice(-6)}-${randomUUID().slice(0, 6)}`;
        // @kody-sync in every file so the merged PR force-syncs them even
        // with the repo's auto-sync toggle off (scenario stays independent
        // of tenant configuration).
        const fixtureFiles = Object.fromEntries(
            Object.entries(FILES).map(([path, f]) => [
                path,
                `${f.content(runTag)}\n\n@kody-sync\n`,
            ]),
        );

        const pr = await ctx.provider.openPR({
            branch: `e2e/rule-file-detection-${runTag}`,
            title: `[e2e] rule-file detection ${runTag}`,
            body: `Automated by Kodus E2E run ${ctx.runId}: merges AGENTS.md + nested CLAUDE.md + lowercase claude.md so the repo-file importer must detect all three.`,
            fixtureFiles,
        });
        await ctx.provider.mergePR!(pr);
        log.info(
            `[detection] merged PR #${pr.number}; waiting for the three imported rules`,
        );

        const imported: FoundRule[] = [];
        try {
            const bySource = await pollUntil<Map<string, FoundRule>>(
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
                    const map = new Map<string, FoundRule>();
                    for (const rule of rules) {
                        if (
                            rule.sourcePath &&
                            RULE_SOURCES.includes(rule.sourcePath)
                        ) {
                            map.set(rule.sourcePath, rule);
                        }
                    }
                    return map.size === RULE_SOURCES.length ? map : null;
                },
                { intervalSec: 10, timeoutSec: 480 },
            );
            ctx.assert(
                bySource,
                `Merged PR #${pr.number} but not all guidance files produced rules within 8min. ` +
                    `Expected sourcePaths: ${RULE_SOURCES.join(', ')}`,
            );
            imported.push(...bySource!.values());

            // 1. Root AGENTS.md imported (repo-wide rule).
            const agents = bySource!.get('AGENTS.md')!;
            ctx.assert(
                agents.status === 'active',
                `AGENTS.md rule not active (status=${agents.status})`,
            );

            // 1b. @-reference INLINED: the customer's '@AGENTS.md references
            // are ignored' complaint. The referenced doc's distinctive token
            // must appear in the imported rule text — the inliner runs
            // BEFORE the LLM extraction, so the token survives restructuring.
            // The LLM may split AGENTS.md into SEVERAL rules — the token
            // must appear in AT LEAST ONE of them.
            const agentsRules = await (async () => {
                const r = await http(
                    `${ctx.target.apiBaseUrl}/kody-rules/find-by-organization-id`,
                    {
                        headers: {
                            Authorization: `Bearer ${session.accessToken}`,
                        },
                        timeoutMs: 15_000,
                    },
                );
                const all: FoundRule[] = [];
                collectRules(r.body, all);
                return all.filter(
                    (rule) =>
                        rule.sourcePath === 'AGENTS.md' &&
                        rule.status !== 'deleted',
                );
            })();
            ctx.assert(
                agentsRules.some((rule) =>
                    (rule.rule ?? '').includes(INLINE_TOKEN),
                ),
                `No AGENTS.md rule contains ${INLINE_TOKEN} — the @docs/e2e-conventions.md reference was not inlined. rules(head)=${agentsRules.map((rule) => (rule.rule ?? '').slice(0, 120)).join(' || ')}`,
            );

            // 2. Nested CLAUDE.md scoped to its subdirectory: the rule's
            // path glob must confine it under services/billing (declared,
            // content-inferred or location-inferred — but never repo-wide).
            const nested = bySource!.get('services/billing/CLAUDE.md')!;
            ctx.assert(
                (nested.path ?? '').includes('services/billing'),
                `Nested CLAUDE.md rule is not scoped to its subdirectory: path="${nested.path}" (expected a glob under services/billing/)`,
            );

            // 3. Lowercase claude.md detected at all (case-insensitivity).
            const lowercase = bySource!.get('packages/ui/claude.md')!;
            ctx.assert(
                lowercase.status === 'active',
                `lowercase claude.md rule not active (status=${lowercase.status})`,
            );

            return {
                pr,
                rules: imported.map((r) => ({
                    sourcePath: r.sourcePath,
                    path: r.path,
                    uuid: r.uuid,
                })),
            };
        } finally {
            for (const rule of imported) {
                try {
                    await http(
                        `${ctx.target.apiBaseUrl}/kody-rules/delete-rule-in-organization-by-id?ruleId=${encodeURIComponent(rule.uuid)}&teamId=${encodeURIComponent(session.teamId)}`,
                        {
                            method: 'DELETE',
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

function collectRules(node: unknown, out: FoundRule[]): void {
    if (Array.isArray(node)) {
        for (const item of node) collectRules(item, out);
        return;
    }
    if (node && typeof node === 'object') {
        const obj = node as Record<string, unknown>;
        if (typeof obj.uuid === 'string' && typeof obj.title === 'string') {
            out.push({
                uuid: obj.uuid,
                title: obj.title,
                rule: typeof obj.rule === 'string' ? obj.rule : undefined,
                path: typeof obj.path === 'string' ? obj.path : undefined,
                sourcePath:
                    typeof obj.sourcePath === 'string'
                        ? obj.sourcePath
                        : undefined,
                status: typeof obj.status === 'string' ? obj.status : undefined,
            });
        }
        for (const v of Object.values(obj)) collectRules(v, out);
    }
}

export default ruleFileDetection;

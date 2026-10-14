/**
 * One-shot data change for "coding-agent files are not Kody Rules" (#1823),
 * over the embedded `rules[]` of every `kodyRules` document:
 *
 *   1. Rules the onboarding import created (origin `repo_file_sync`, stored at
 *      `repositoryId: "global"`, no `sourceRepositoryId`) that are ACTIVE go
 *      back to PENDING, unless they came from a Kody rule template file. They
 *      were imported from coding-agent files or inferred from dependency
 *      manifests, and "approval" was a pre-checked box nobody unchecked.
 *      Re-approving is one click in the Pending area.
 *   2. `pinnedSync` is cleared everywhere: `@kody-sync` no longer does
 *      anything.
 *
 * Rules a team synced on purpose (repository scope) or imported from a global
 * source repository keep their status: they are frozen, not removed.
 *
 * Idempotent. Dependency-free (only the `mongodb` driver) so the migration
 * build can compile it in isolation; the file-location check mirrors
 * `KODY_RULE_FILE_PATTERNS` in libs/common/utils/kody-rules/file-patterns.ts.
 */
import { Db } from 'mongodb';

export const ONBOARDING_IMPORT_REASON =
    'Imported during onboarding from coding-agent files or dependency manifests; awaiting approval.';

// A Kody rule template location, at any depth (`.agents/rules/` is a
// coding-agent location even though it ends in `rules/`).
const AGENT_RULES_DIR = /(?:^|\/)\.agents\/rules\//i;
const KODY_RULE_LOCATIONS: RegExp[] = [
    /(?:^|\/)\.kody\/rules\/./i,
    /(?:^|\/)\.rules\/./i,
    /(?:^|\/)docs\/coding-standards\/./i,
    /(?:^|\/)rules\/.+\.md$/i,
];

function isKodyRuleFile(sourcePath: unknown): boolean {
    if (typeof sourcePath !== 'string' || !sourcePath) return false;
    const path = sourcePath.split('#')[0].replace(/\\/g, '/');
    if (AGENT_RULES_DIR.test(path)) return false;
    return KODY_RULE_LOCATIONS.some((re) => re.test(path));
}

function isOnboardingImport(rule: any): boolean {
    return (
        rule?.origin === 'repo_file_sync' &&
        rule?.repositoryId === 'global' &&
        !rule?.sourceRepositoryId
    );
}

/** The changed rule, or null when nothing changes. */
export function freezeAgentFileRule(rule: any): any | null {
    if (!rule) return null;
    let changed = false;
    const next = { ...rule };

    if (
        isOnboardingImport(rule) &&
        rule.status === 'active' &&
        !isKodyRuleFile(rule.sourcePath)
    ) {
        next.status = 'pending';
        next.reason = ONBOARDING_IMPORT_REASON;
        changed = true;
    }

    if (rule.pinnedSync === true) {
        next.pinnedSync = false;
        changed = true;
    }

    return changed ? next : null;
}

export type FreezeAgentFileRulesResult = {
    docsScanned: number;
    docsUpdated: number;
    movedToPending: number;
    pinsCleared: number;
    /** Organizations that now have onboarding imports awaiting approval. */
    orgsWithPending: string[];
};

export async function freezeAgentFileRules(
    db: Db,
    opts: { dryRun?: boolean; log?: (msg: string) => void } = {},
): Promise<FreezeAgentFileRulesResult> {
    const dryRun = opts.dryRun ?? false;
    const log = opts.log ?? (() => {});
    const collection = db.collection('kodyRules');

    const result: FreezeAgentFileRulesResult = {
        docsScanned: 0,
        docsUpdated: 0,
        movedToPending: 0,
        pinsCleared: 0,
        orgsWithPending: [],
    };

    for await (const doc of collection.find({})) {
        result.docsScanned += 1;
        const rules: any[] = Array.isArray(doc.rules) ? doc.rules : [];

        let docChanged = false;
        let movedInDoc = 0;
        const nextRules = rules.map((rule) => {
            const next = freezeAgentFileRule(rule);
            if (!next) return rule;
            docChanged = true;
            if (next.status !== rule.status) movedInDoc += 1;
            if (rule.pinnedSync === true) result.pinsCleared += 1;
            return next;
        });

        if (!docChanged) continue;
        result.docsUpdated += 1;
        result.movedToPending += movedInDoc;
        if (movedInDoc > 0 && doc.organizationId) {
            result.orgsWithPending.push(String(doc.organizationId));
        }

        if (!dryRun) {
            await collection.updateOne(
                { _id: doc._id },
                { $set: { rules: nextRules } },
            );
        }
    }

    log(
        `[freeze-agent-file-rules]${dryRun ? ' [DRY RUN]' : ''} scanned ${result.docsScanned} org doc(s); ` +
            `${result.docsUpdated} doc(s) ${dryRun ? 'would be ' : ''}updated; ` +
            `${result.movedToPending} onboarding import(s) moved to pending across ${result.orgsWithPending.length} org(s); ` +
            `${result.pinsCleared} @kody-sync pin(s) cleared.`,
    );

    return result;
}

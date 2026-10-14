/**
 * One-shot data change for "coding-agent files are not Kody Rules" (#1823),
 * over the embedded `rules[]` of every `kodyRules` document:
 *
 *   1. Rules the onboarding import created (origin `repo_file_sync`, stored at
 *      `repositoryId: "global"`, no `sourceRepositoryId`) that are active,
 *      pending or paused are DELETED, unless they came from a Kody rule
 *      template file. They were imported from coding-agent files or inferred
 *      from dependency manifests, "approval" was a pre-checked box nobody
 *      unchecked, each repository's copy of a file became its own org-wide
 *      rule, and the source repository was never stored to scope them back.
 *      The coding-agent instructions setting reads the same files per
 *      repository instead. Each one keeps `reason` and `previousStatus`, so
 *      `restoreAgentFileRules` can put it back.
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

export const ONBOARDING_IMPORT_REMOVED_REASON =
    'Imported during onboarding from coding-agent files or dependency manifests; removed when those files stopped becoming rules.';

const REMOVABLE_STATUSES = new Set(['active', 'pending', 'paused']);

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
        REMOVABLE_STATUSES.has(rule.status) &&
        !isKodyRuleFile(rule.sourcePath)
    ) {
        next.status = 'deleted';
        next.previousStatus = rule.status;
        next.reason = ONBOARDING_IMPORT_REMOVED_REASON;
        changed = true;
    }
    if (rule.pinnedSync === true) {
        next.pinnedSync = false;
        changed = true;
    }
    return changed ? next : null;
}

/** The rule as it was before `freezeAgentFileRule` removed it, or null. */
export function restoreAgentFileRule(rule: any): any | null {
    if (
        rule?.status !== 'deleted' ||
        rule.reason !== ONBOARDING_IMPORT_REMOVED_REASON ||
        !REMOVABLE_STATUSES.has(rule.previousStatus)
    ) {
        return null;
    }
    const { previousStatus, reason: _reason, ...rest } = rule;
    return { ...rest, status: previousStatus };
}

export type FreezeAgentFileRulesResult = {
    docsScanned: number;
    docsUpdated: number;
    removed: number;
    pinsCleared: number;
    /** Organizations whose onboarding imports were removed. */
    orgsWithRemoved: string[];
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
        removed: 0,
        pinsCleared: 0,
        orgsWithRemoved: [],
    };

    for await (const doc of collection.find({})) {
        result.docsScanned += 1;
        const rules: any[] = Array.isArray(doc.rules) ? doc.rules : [];

        let docChanged = false;
        let removedInDoc = 0;
        const nextRules = rules.map((rule) => {
            const next = freezeAgentFileRule(rule);
            if (!next) return rule;
            docChanged = true;
            if (next.status !== rule.status) removedInDoc += 1;
            if (rule.pinnedSync === true) result.pinsCleared += 1;
            return next;
        });

        if (!docChanged) continue;
        result.docsUpdated += 1;
        result.removed += removedInDoc;
        if (removedInDoc > 0 && doc.organizationId) {
            result.orgsWithRemoved.push(String(doc.organizationId));
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
            `${result.removed} onboarding import(s) removed across ${result.orgsWithRemoved.length} org(s); ` +
            `${result.pinsCleared} @kody-sync pin(s) cleared.`,
    );

    return result;
}

/**
 * Undoes the removal half of `freezeAgentFileRules`, for every organization
 * or one (`organizationId`). Cleared pins stay cleared.
 */
export async function restoreAgentFileRules(
    db: Db,
    opts: { organizationId?: string; log?: (msg: string) => void } = {},
): Promise<{ restored: number }> {
    const log = opts.log ?? (() => {});
    const collection = db.collection('kodyRules');
    const filter = opts.organizationId
        ? { organizationId: opts.organizationId }
        : {};
    let restored = 0;

    for await (const doc of collection.find(filter)) {
        const rules: any[] = Array.isArray(doc.rules) ? doc.rules : [];
        let restoredInDoc = 0;
        const nextRules = rules.map((rule) => {
            const next = restoreAgentFileRule(rule);
            if (!next) return rule;
            restoredInDoc += 1;
            return next;
        });
        if (restoredInDoc === 0) continue;
        restored += restoredInDoc;
        await collection.updateOne(
            { _id: doc._id },
            { $set: { rules: nextRules } },
        );
    }

    log(
        `[freeze-agent-file-rules] restored ${restored} onboarding import(s)${opts.organizationId ? ` for org ${opts.organizationId}` : ''}.`,
    );
    return { restored };
}

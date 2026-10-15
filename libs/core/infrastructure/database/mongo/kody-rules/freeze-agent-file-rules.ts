/**
 * One-shot data change for "coding-agent files are not Kody Rules" (#1823),
 * over the embedded `rules[]` of every `kodyRules` document:
 *
 *   1. Rules the onboarding import created from a repository file (origin
 *      `repo_file_sync`, stored at `repositoryId: "global"`, no
 *      `sourceRepositoryId`, a `sourcePath`) that are active, pending or
 *      paused are DELETED, unless the file is under `.kody/rules/`. Every
 *      onboarding import went through the LLM converter; outside
 *      `.kody/rules/` the files were coding-agent instructions (CLAUDE.md,
 *      .cursor/rules, Claude skills, ...), "approval" was a pre-checked box,
 *      each repository's copy became its own org-wide rule, and the source
 *      repository was never stored to scope them back. The coding-agent
 *      instructions setting reads the same files per repository instead. Each
 *      one keeps `reason` and `previousStatus`, so `restoreAgentFileRules` can
 *      put it back. Onboarding rules without a `sourcePath` were inferred
 *      from dependency manifests, not imported from a file, and stay.
 *   2. `pinnedSync` is cleared everywhere: `@kody-sync` no longer does
 *      anything.
 *
 * Rules a team synced on purpose (repository scope) or imported from a global
 * source repository keep their status: they are frozen, not removed.
 *
 * Idempotent. Dependency-free (only the `mongodb` driver) so the migration
 * build can compile it in isolation.
 */
import { Db } from 'mongodb';

export const ONBOARDING_IMPORT_REMOVED_REASON =
    'Imported during onboarding from a repository file outside .kody/rules; removed when those files stopped becoming rules.';

const REMOVABLE_STATUSES = new Set(['active', 'pending', 'paused']);

const KODY_RULES_DIR = /(?:^|\/)\.kody\/rules\/./i;

/** Imported from a file outside `.kody/rules/`. */
function isRemovableSource(sourcePath: unknown): boolean {
    if (typeof sourcePath !== 'string' || !sourcePath.trim()) return false;
    const path = sourcePath.split('#')[0].replace(/\\/g, '/');
    return !KODY_RULES_DIR.test(path);
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
        isRemovableSource(rule.sourcePath)
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

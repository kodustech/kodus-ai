/**
 * One-shot data change for "coding-agent files are not Kody Rules" (#1823),
 * over the embedded `rules[]` of every `kodyRules` document:
 *
 *   1. Rules the onboarding import created from a repository file (origin
 *      `repo_file_sync`, stored at `repositoryId: "global"`, no
 *      `sourceRepositoryId`, a `sourcePath`) that are active, pending or
 *      paused are DELETED, unless the file is in a Repository Rules location
 *      (`.kody/rules/`, `.rules/`, `docs/coding-standards/`, `rules/**.md`),
 *      where a file that follows the template is a Kody Rule. Elsewhere the
 *      files were coding-agent instructions (CLAUDE.md, .cursor/rules, Claude
 *      skills, ...) the LLM converter turned into rules, "approval" was a
 *      pre-checked box,
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

/** Where `dirPrefix` starts as a path segment, or -1 (as in kody-rule-file-parser.ts). */
function dirSegmentEnd(pathLower: string, dirPrefix: string): number {
    if (pathLower.startsWith(dirPrefix)) return dirPrefix.length;
    const idx = pathLower.indexOf('/' + dirPrefix);
    return idx >= 0 ? idx + 1 + dirPrefix.length : -1;
}

/**
 * A Repository Rules location: `.kody/rules/`, `.rules/`,
 * `docs/coding-standards/`, or a `.md` file under `rules/`. A file there that
 * follows the template is a Kody Rule, not a coding-agent file. Mirrors
 * `isKodyRuleTemplateFile`, which this file cannot import, and also leaves
 * out `.cursor/rules/`.
 */
function isRepositoryRulesLocation(sourcePath: string): boolean {
    const lower = sourcePath.split('#')[0].replace(/\\/g, '/').toLowerCase();
    for (const agentDir of ['.agents/rules/', '.claude/skills/', '.cursor/']) {
        if (dirSegmentEnd(lower, agentDir) >= 0) return false;
    }
    for (const dir of ['.kody/rules/', '.rules/', 'docs/coding-standards/']) {
        const end = dirSegmentEnd(lower, dir);
        if (end >= 0 && lower.length > end) return true;
    }
    const rulesEnd = dirSegmentEnd(lower, 'rules/');
    return rulesEnd >= 0 && lower.length > rulesEnd && lower.endsWith('.md');
}

/** Imported from a file outside the Repository Rules locations. */
function isRemovableSource(sourcePath: unknown): boolean {
    if (typeof sourcePath !== 'string' || !sourcePath.trim()) return false;
    return !isRepositoryRulesLocation(sourcePath);
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

/** Marks a rule `restoreTemplateOnboardingImports` brought back. */
const RESTORED_MARK = 'restoredByTemplateMigration';

/**
 * Brings back the onboarding imports from Repository Rules locations that the
 * first run of this migration removed (before those locations were spared).
 */
export async function restoreTemplateOnboardingImports(
    db: Db,
    opts: { log?: (msg: string) => void } = {},
): Promise<{ restored: number; orgs: string[] }> {
    const result = await rewriteRules(db, (rule) => {
        if (
            typeof rule?.sourcePath !== 'string' ||
            !isRepositoryRulesLocation(rule.sourcePath)
        ) {
            return null;
        }
        const restored = restoreAgentFileRule(rule);
        return restored ? { ...restored, [RESTORED_MARK]: true } : null;
    });
    opts.log?.(
        `[freeze-agent-file-rules] restored ${result.changed} onboarding import(s) from Repository Rules locations across ${result.orgs.length} org(s).`,
    );
    return { restored: result.changed, orgs: result.orgs };
}

/**
 * Undoes `restoreTemplateOnboardingImports`: removes again only the rules it
 * restored (marked), so an install where the freeze already kept them is left
 * alone. They stay restorable.
 */
export async function removeTemplateOnboardingImports(
    db: Db,
    opts: { log?: (msg: string) => void } = {},
): Promise<{ removed: number }> {
    const result = await rewriteRules(db, (rule) => {
        if (rule?.[RESTORED_MARK] !== true) return null;
        const { [RESTORED_MARK]: _mark, ...rest } = rule;
        return {
            ...rest,
            status: 'deleted',
            previousStatus: rule.status,
            reason: ONBOARDING_IMPORT_REMOVED_REASON,
        };
    });
    opts.log?.(
        `[freeze-agent-file-rules] removed ${result.changed} onboarding import(s) from Repository Rules locations.`,
    );
    return { removed: result.changed };
}

async function rewriteRules(
    db: Db,
    change: (rule: any) => any | null,
): Promise<{ changed: number; orgs: string[] }> {
    const collection = db.collection('kodyRules');
    let changed = 0;
    const orgs: string[] = [];
    for await (const doc of collection.find({})) {
        const rules: any[] = Array.isArray(doc.rules) ? doc.rules : [];
        let changedInDoc = 0;
        const nextRules = rules.map((rule) => {
            const next = change(rule);
            if (!next) return rule;
            changedInDoc += 1;
            return next;
        });
        if (changedInDoc === 0) continue;
        changed += changedInDoc;
        if (doc.organizationId) orgs.push(String(doc.organizationId));
        await collection.updateOne(
            { _id: doc._id },
            { $set: { rules: nextRules } },
        );
    }
    return { changed, orgs };
}

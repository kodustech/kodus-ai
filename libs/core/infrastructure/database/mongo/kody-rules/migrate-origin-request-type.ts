/**
 * One-shot backfill for the widened Kody Rules `origin` enum and the
 * generalized `requestType` values, over the embedded `rules[]` of every
 * `kodyRules` document.
 *
 *   1. `origin` — legacy (`user`/`library`/`generated`) → widened set:
 *        - IDE/repo rule-file sourcePath → `repo_file_sync`
 *        - legacy `library`             → `library`
 *        - legacy `generated`           → `past_reviews`
 *        - else                         → `manual`
 *   2. `requestType` — `memory_create` → `create`, `memory_update` → `update`.
 *
 * Idempotent: rules already on a widened `origin`/`requestType` are left as-is.
 *
 * Dependency-free (only the `mongodb` driver) so it can be imported by both a
 * TypeORM migration (the boot path, recorded in the Postgres migrations table)
 * and a standalone CLI (dry-run / manual pre-run). See mongo-migration-client.
 */
import { Db } from 'mongodb';

const NEW_ORIGINS = new Set<string>([
    'manual',
    'library',
    'past_reviews',
    'repo_file_sync',
    'onboarding_repo_analysis',
    'mcp_agent',
    'cli',
]);

const REQUEST_TYPE_MAP: Record<string, string> = {
    memory_create: 'create',
    memory_update: 'update',
};

// Source-path shapes that can only come from the IDE-rule sync flow — mirrors
// libs/common/utils/kody-rules/file-patterns.ts. Inlined so the module stays
// dependency-free.
const IDE_RULE_SOURCE_PATTERNS: RegExp[] = [
    /(?:^|\/)\.cursorrules$/,
    /(?:^|\/)\.cursor\/rules\//,
    /(?:^|\/)\.github\/copilot-instructions\.md$/,
    /(?:^|\/)\.github\/instructions\//,
    /(?:^|\/)\.agents?\.md$/,
    /(?:^|\/)CLAUDE\.md$/,
    /(?:^|\/)\.claude\//,
    /(?:^|\/)\.windsurfrules$/,
    /(?:^|\/)\.sourcegraph\//,
    /(?:^|\/)\.opencode\.json$/,
    /(?:^|\/)\.aider\.conf\.yml$/,
    /(?:^|\/)\.aiderignore$/,
    /(?:^|\/)\.rules\//,
    /(?:^|\/)\.kody\/rules\//,
    /(?:^|\/)docs\/coding-standards\//,
];

function isIdeRuleSource(sourcePath?: string | null): boolean {
    if (!sourcePath) return false;
    return IDE_RULE_SOURCE_PATTERNS.some((p) => p.test(sourcePath));
}

function mapLegacyOrigin(
    legacyOrigin: string | undefined,
    sourcePath?: string | null,
): string {
    if (legacyOrigin === 'library') return 'library';
    if (isIdeRuleSource(sourcePath)) return 'repo_file_sync';
    if (legacyOrigin === 'generated') return 'past_reviews';
    return 'manual';
}

/** Returns the migrated rule, or null when nothing changed. */
export function migrateRule(rule: any): any | null {
    let changed = false;
    const next = { ...rule };

    const origin = rule?.origin;
    if (!origin || !NEW_ORIGINS.has(origin)) {
        next.origin = mapLegacyOrigin(origin, rule?.sourcePath);
        changed = true;
    }

    const mappedRequestType = REQUEST_TYPE_MAP[rule?.requestType];
    if (mappedRequestType) {
        next.requestType = mappedRequestType;
        changed = true;
    }

    return changed ? next : null;
}

export type MigrateKodyRulesOptions = {
    dryRun?: boolean;
    log?: (msg: string) => void;
};

export type MigrateKodyRulesResult = {
    docsScanned: number;
    docsUpdated: number;
    rulesMigrated: number;
};

export async function migrateKodyRulesOriginRequestType(
    db: Db,
    opts: MigrateKodyRulesOptions = {},
): Promise<MigrateKodyRulesResult> {
    const dryRun = opts.dryRun ?? false;
    const log = opts.log ?? (() => {});
    const collection = db.collection('kodyRules');

    let docsScanned = 0;
    let docsUpdated = 0;
    let rulesMigrated = 0;

    const cursor = collection.find({});
    for await (const doc of cursor) {
        docsScanned += 1;
        const rules: any[] = Array.isArray(doc.rules) ? doc.rules : [];

        let docChanged = false;
        const nextRules = rules.map((rule) => {
            const migrated = migrateRule(rule);
            if (migrated) {
                docChanged = true;
                rulesMigrated += 1;
                return migrated;
            }
            return rule;
        });

        if (!docChanged) continue;
        docsUpdated += 1;

        if (!dryRun) {
            await collection.updateOne(
                { _id: doc._id },
                { $set: { rules: nextRules } },
            );
        }
    }

    log(
        `[migrate-kody-rules]${dryRun ? ' [DRY RUN]' : ''} scanned ${docsScanned} org doc(s); ` +
            `${docsUpdated} doc(s) ${dryRun ? 'would be' : ''} updated; ${rulesMigrated} rule(s) remapped.`,
    );

    return { docsScanned, docsUpdated, rulesMigrated };
}

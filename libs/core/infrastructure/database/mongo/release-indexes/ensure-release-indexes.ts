/**
 * The Mongo indexes this release declared on Mongoose schemas, as a migration
 * builds them. Schema indexes are built on boot only while MONGO_AUTO_INDEX is
 * on, so with it off nothing else would create these, the unique ones that
 * enforce a rule included (one active security scan per repository, one issue
 * per finding).
 *
 * Dependency-free (only the driver's types), like the rest of this folder: the
 * migration build compiles it in isolation. The definitions repeat the
 * schemas'; ensure-release-indexes.spec.ts fails when the two drift apart.
 */
import { CreateIndexesOptions, Db, IndexSpecification } from 'mongodb';

export interface ReleaseIndex {
    collection: string;
    key: IndexSpecification;
    options: CreateIndexesOptions & { name: string };
}

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

export const RELEASE_INDEXES: ReleaseIndex[] = [
    {
        collection: 'kodus-agent-sessions',
        key: { updatedAt: 1 },
        options: {
            name: 'ttl_updatedAt',
            expireAfterSeconds: THIRTY_DAYS_SECONDS,
        },
    },
    {
        collection: 'kodus_credit_charges',
        key: { organizationId: 1, prNumber: 1, spanAt: -1 },
        options: {
            name: 'idx_org_pr_spanAt',
            partialFilterExpression: { prNumber: { $exists: true } },
        },
    },
    {
        collection: 'issues',
        key: { organizationId: 1, updatedAt: -1 },
        options: { name: 'organization_updated' },
    },
    {
        collection: 'issues',
        key: { 'organizationId': 1, 'repository.id': 1, 'fingerprint': 1 },
        options: {
            name: 'organization_repository_fingerprint_unique',
            unique: true,
            partialFilterExpression: { fingerprint: { $exists: true } },
        },
    },
    {
        collection: 'pullRequests',
        key: { 'organizationId': 1, 'user.id': 1, 'createdAt': -1 },
        options: { name: 'idx_org_user_id_createdAt_for_seat_labels' },
    },
    {
        collection: 'security_scans',
        key: { 'organizationId': 1, 'repository.id': 1, 'createdAt': -1 },
        options: { name: 'organization_repository_recent' },
    },
    {
        collection: 'security_scans',
        key: { activeKey: 1 },
        options: {
            name: 'one_active_scan_per_repository',
            unique: true,
            partialFilterExpression: { activeKey: { $exists: true } },
        },
    },
];

// What an index build can hit that no retry fixes, and that must not stop the
// boot that runs the migration: the old code ran without these indexes.
const DUPLICATE_KEY = 11000; // existing data breaks a unique index
const INDEX_OPTIONS_CONFLICT = 85; // the same key exists under another name
const INDEX_KEY_SPECS_CONFLICT = 86; // the name exists with another key or options

export interface EnsureReleaseIndexesResult {
    built: string[];
    failed: Array<{ index: string; reason: string }>;
}

/**
 * Build each index; createIndex is a no-op for one that already exists with
 * the same key and options. A build the data or an older index refuses is
 * reported and skipped, never thrown: a human has to fix the data or the
 * conflicting index, and the rest still gets built.
 */
export async function ensureReleaseIndexes(
    db: Db,
    log: (message: string) => void,
    indexes: ReleaseIndex[] = RELEASE_INDEXES,
): Promise<EnsureReleaseIndexesResult> {
    const result: EnsureReleaseIndexesResult = { built: [], failed: [] };
    for (const { collection, key, options } of indexes) {
        const index = `${collection}.${options.name}`;
        try {
            await db.collection(collection).createIndex(key, options);
            result.built.push(index);
            log(`[release-indexes] ${index} ok`);
        } catch (error) {
            const code = (error as { code?: number }).code;
            if (
                code !== DUPLICATE_KEY &&
                code !== INDEX_OPTIONS_CONFLICT &&
                code !== INDEX_KEY_SPECS_CONFLICT
            ) {
                throw error;
            }
            const reason = (error as Error).message;
            result.failed.push({ index, reason });
            log(
                `[release-indexes] ERROR ${index} not built, fix by hand: ${reason}`,
            );
        }
    }
    return result;
}

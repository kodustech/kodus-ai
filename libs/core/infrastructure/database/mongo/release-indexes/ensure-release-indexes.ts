/**
 * Builds the indexes this release added (release-index-definitions.ts) from a
 * migration, so they exist with MONGO_AUTO_INDEX off too.
 *
 * Dependency-free (only the driver's types), like the rest of this folder: the
 * migration build compiles it in isolation.
 */
import { Db } from 'mongodb';

import { RELEASE_INDEXES, ReleaseIndex } from './release-index-definitions';

export { RELEASE_INDEXES };
export type { ReleaseIndex };

// What an index build can hit that no retry fixes, and that must not stop the
// boot that runs the migration: the old code ran without these indexes.
// The reason is worded here, never taken from the server's message: a
// duplicate-key message carries the colliding document's values.
const REFUSALS: Record<number, string> = {
    11000: 'existing documents break this unique index; deduplicate them',
    85: 'the same key is indexed under another name',
    86: 'an index with this name exists with another key or options',
};

export interface EnsureReleaseIndexesResult {
    /** Present after the call: built now, or already there. */
    ensured: string[];
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
    const result: EnsureReleaseIndexesResult = { ensured: [], failed: [] };
    for (const { collection, key, options } of indexes) {
        const index = `${collection}.${options.name}`;
        try {
            await db.collection(collection).createIndex(key, options);
            result.ensured.push(index);
            log(`[release-indexes] ${index} ok`);
        } catch (error) {
            const code = (error as { code?: number }).code;
            const reason =
                code !== undefined && Object.hasOwn(REFUSALS, code)
                    ? REFUSALS[code]
                    : undefined;
            if (!reason) throw error;
            result.failed.push({ index, reason });
            log(
                `[release-indexes] ERROR ${index} not built (code ${code}), fix by hand: ${reason}`,
            );
        }
    }
    return result;
}

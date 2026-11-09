/**
 * One-shot cleanup of suggestion implementation statuses stored in a spelling
 * other than the three canonical values (`IMPLEMENTED`, `not implemented`, …).
 * The implementation check stored whatever string the model answered until it
 * validated its output; readers compare the exact lowercase values, so these
 * read as not implemented in the Cockpit and as resolved in thread resolution.
 *
 * Only spellings that map to exactly one status are rewritten. Anything else
 * (a sentence, null, an object) is left alone: guessing its status would be a
 * recompute, which is out of scope.
 *
 * Idempotent: a canonical value never matches. Run by hand, off-peak
 * (`pnpm mongo:migrate suggestion-implementation-status [--dry-run]`), not on
 * boot: the read and each `updateMany` scan the whole pullRequests
 * collection, which must not hold API startup.
 */
import { Db } from 'mongodb';

import {
    isImplementationStatus,
    normalizeImplementationStatus,
} from '../../../../../platformData/domain/pullRequests/implementation-status';

export type NormalizeImplementationStatusOptions = {
    dryRun?: boolean;
    log?: (msg: string) => void;
};

export type NormalizeImplementationStatusResult = {
    /** Per stored spelling: pull requests changed (or, on a dry run, that would be). */
    rewritten: Record<string, number>;
    /** Stored values no status can be read from. */
    leftAlone: string[];
};

export async function normalizeSuggestionImplementationStatus(
    db: Db,
    opts: NormalizeImplementationStatusOptions = {},
): Promise<NormalizeImplementationStatusResult> {
    const dryRun = opts.dryRun ?? false;
    const log = opts.log ?? (() => {});
    const collection = db.collection('pullRequests');
    const path = 'files.suggestions.implementationStatus';

    // Not `distinct`: it answers in one BSON document capped at 16MB, and the
    // stored values include free text. A cursor has no cap.
    const stored = collection.aggregate<{ _id: unknown }>(
        [
            { $unwind: '$files' },
            { $unwind: '$files.suggestions' },
            { $match: { [path]: { $type: 'string' } } },
            { $group: { _id: `$${path}` } },
        ],
        { allowDiskUse: true },
    );
    const result: NormalizeImplementationStatusResult = {
        rewritten: {},
        leftAlone: [],
    };

    for await (const { _id: value } of stored) {
        if (typeof value !== 'string' || isImplementationStatus(value))
            continue;
        const status = normalizeImplementationStatus(value);
        if (!status) {
            result.leftAlone.push(value);
            continue;
        }
        if (dryRun) {
            result.rewritten[value] = await collection.countDocuments({
                [path]: value,
            });
            continue;
        }
        const { modifiedCount } = await collection.updateMany(
            { [path]: value },
            {
                $set: {
                    'files.$[f].suggestions.$[s].implementationStatus': status,
                },
            },
            {
                // Only files holding the value: `$[]` fails on a file stored
                // without a suggestions array.
                arrayFilters: [
                    { 'f.suggestions.implementationStatus': value },
                    { 's.implementationStatus': value },
                ],
            },
        );
        result.rewritten[value] = modifiedCount;
    }

    log(
        `[suggestion-implementation-status] ${dryRun ? 'would rewrite' : 'rewrote'} ${JSON.stringify(result.rewritten)}; left ${result.leftAlone.length} unreadable value(s) alone`,
    );
    return result;
}

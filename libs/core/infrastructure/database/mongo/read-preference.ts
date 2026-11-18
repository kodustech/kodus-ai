/**
 * Where reads that can be a few seconds behind go: dashboards, token usage,
 * analytics ingestion. They are the heaviest scans in the app and none of
 * them decides anything a stale second would change, so they run on the
 * replica set member tagged for it (`workload=analytics`) instead of the
 * primary that serves reviews and webhooks.
 *
 * - Prefers members with the analytics tag, then any secondary (`{}`), then
 *   the primary: a missing tag or a member down never fails the read.
 * - `maxStalenessSeconds` keeps a member that fell far behind out of it.
 * - MONGO_ANALYTICS_READ_TAGS overrides the tag sets without a code change:
 *   `key:value,key:value;key:value` (`;` separates sets, tried in order).
 *
 * Not for anything that bills or approves: those read the primary.
 *
 * Dependency-free (only the driver), like the other helpers in this folder.
 */
import { ReadPreference, type ReadPreferenceMode, type TagSet } from 'mongodb';

const DEFAULT_TAGS = 'workload:analytics';
const MAX_STALENESS_SECONDS = 90;

export function parseReadTags(raw: string | undefined): TagSet[] {
    const sets = (raw?.trim() ? raw : DEFAULT_TAGS)
        .split(';')
        .map((set) => set.trim())
        .filter(Boolean)
        .map(
            (set) =>
                Object.fromEntries(
                    set
                        .split(',')
                        .map((pair) => pair.split(':').map((s) => s.trim()))
                        .filter(([key, value]) => key && value),
                ) as TagSet,
        )
        .filter((set) => Object.keys(set).length > 0);
    // The empty set last: any secondary when no tagged member is available.
    return [...sets, {}];
}

export const ANALYTICS_READ_PREFERENCE = new ReadPreference(
    ReadPreference.SECONDARY_PREFERRED,
    parseReadTags(process.env.MONGO_ANALYTICS_READ_TAGS),
    { maxStalenessSeconds: MAX_STALENESS_SECONDS },
);

/**
 * The same preference for `Query.read()`. Mongoose's typings declare only the
 * mode string there, while its runtime takes a ReadPreference as is
 * (mongoose/lib/query.js, `Query.prototype.read`); the replica-set test of
 * this file proves a find honours it. Aggregations and the native driver
 * take ANALYTICS_READ_PREFERENCE directly.
 */
export const ANALYTICS_QUERY_READ =
    ANALYTICS_READ_PREFERENCE as unknown as ReadPreferenceMode;

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
 * - The tag is a constant: one tagging exists. A second would come with its
 *   own configuration, documented, rather than a key nobody sets.
 *
 * Not for anything that bills or approves: those read the primary.
 *
 * Dependency-free (only the driver), like the other helpers in this folder.
 */
import { ReadPreference, type ReadPreferenceMode, type TagSet } from 'mongodb';

const MAX_STALENESS_SECONDS = 90;

/**
 * The analytics member first, then any secondary, then the primary. Module
 * private: the preference holds this array by reference.
 */
const ANALYTICS_READ_TAGS: TagSet[] = [{ workload: 'analytics' }, {}];

export const ANALYTICS_READ_PREFERENCE = new ReadPreference(
    ReadPreference.SECONDARY_PREFERRED,
    ANALYTICS_READ_TAGS,
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

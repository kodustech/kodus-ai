/**
 * The Mongo indexes this release added, defined once. Each schema declares its
 * index from here (`schema.index(def.key, def.options)`), and the
 * 2026112100000000 migration builds the same list, so turning autoIndex off
 * leaves none missing and the two can never differ.
 *
 * Plain data, no imports: the migration build compiles this file in isolation.
 */
export interface ReleaseIndex {
    collection: string;
    key: Record<string, 1 | -1>;
    options: {
        name: string;
        unique?: boolean;
        background?: boolean;
        expireAfterSeconds?: number;
        partialFilterExpression?: Record<string, any>;
    };
}

export const RELEASE_INDEX = {
    // A conversation the thread has not touched in 30 days expires.
    agentSessionTtl: {
        collection: 'kodus-agent-sessions',
        key: { updatedAt: 1 },
        options: {
            name: 'ttl_updatedAt',
            expireAfterSeconds: 30 * 24 * 60 * 60,
            background: true,
        },
    },
    creditChargesByPr: {
        collection: 'kodus_credit_charges',
        key: { organizationId: 1, prNumber: 1, spanAt: -1 },
        options: {
            name: 'idx_org_pr_spanAt',
            background: true,
            partialFilterExpression: { prNumber: { $exists: true } },
        },
    },
    issuesByLatestWrite: {
        collection: 'issues',
        key: { organizationId: 1, updatedAt: -1 },
        options: { name: 'organization_updated', background: true },
    },
    oneIssuePerFinding: {
        collection: 'issues',
        key: { 'organizationId': 1, 'repository.id': 1, 'fingerprint': 1 },
        options: {
            name: 'organization_repository_fingerprint_unique',
            unique: true,
            partialFilterExpression: { fingerprint: { $exists: true } },
            background: true,
        },
    },
    pullRequestsBySeatAuthor: {
        collection: 'pullRequests',
        key: { 'organizationId': 1, 'user.id': 1, 'createdAt': -1 },
        options: { name: 'idx_org_user_id_createdAt_for_seat_labels' },
    },
    securityScansRecent: {
        collection: 'security_scans',
        key: { 'organizationId': 1, 'repository.id': 1, 'createdAt': -1 },
        options: { name: 'organization_repository_recent' },
    },
    oneActiveScanPerRepository: {
        collection: 'security_scans',
        key: { activeKey: 1 },
        options: {
            name: 'one_active_scan_per_repository',
            unique: true,
            partialFilterExpression: { activeKey: { $exists: true } },
        },
    },
    // One recorded conclusion per repository, file and class: an
    // incremental deep scan reads them all for its repository.
    scanCoveragePerArea: {
        collection: 'security_scan_coverage',
        key: {
            'organizationId': 1,
            'repository.platform': 1,
            'repository.host': 1,
            'repository.id': 1,
            'filePath': 1,
            'vulnerabilityClass': 1,
        },
        options: {
            name: 'repository_file_class_unique',
            unique: true,
        },
    },
    // The issue a folded deep-scan place belongs to, found by its alias.
    scanIssueByAlias: {
        collection: 'issues',
        key: { organizationId: 1, fingerprintAliases: 1 },
        options: {
            name: 'organization_fingerprint_aliases',
            partialFilterExpression: { fingerprintAliases: { $exists: true } },
        },
    },
    // Schedules due to run, read by the deep-scan schedule cron.
    scanSchedulesDue: {
        collection: 'security_scan_schedules',
        key: { enabled: 1, nextRunAt: 1 },
        options: { name: 'enabled_next_run' },
    },
    oneScanSchedulePerRepository: {
        collection: 'security_scan_schedules',
        key: {
            'organizationId': 1,
            'repository.platform': 1,
            'repository.host': 1,
            'repository.id': 1,
        },
        options: { name: 'one_schedule_per_repository', unique: true },
    },
} satisfies Record<string, ReleaseIndex>;

export const RELEASE_INDEXES: ReleaseIndex[] = Object.values(RELEASE_INDEX);

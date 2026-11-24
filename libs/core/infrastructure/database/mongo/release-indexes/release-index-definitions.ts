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
} satisfies Record<string, ReleaseIndex>;

export const RELEASE_INDEXES: ReleaseIndex[] = Object.values(RELEASE_INDEX);

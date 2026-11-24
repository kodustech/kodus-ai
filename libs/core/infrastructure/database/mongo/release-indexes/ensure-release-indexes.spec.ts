import { Schema } from 'mongoose';

import { AgentSessionSchema } from '@libs/agents/infrastructure/persistence/schemas/agent-session.model';
import { KodusCreditChargeModelSchema } from '@libs/analytics/infrastructure/adapters/repositories/schemas/kodusCreditCharge.model';
import { IssuesSchema } from '@libs/issues/infrastructure/adapters/repositories/schemas/issues.model';
import { PullRequestsSchema } from '@libs/platformData/infrastructure/adapters/repositories/schemas/pullRequests.model';
import { SecurityScanSchema } from '@libs/security-scan/infrastructure/security-scan.model';
import { SecurityScanCoverageSchema } from '@libs/security-scan/infrastructure/security-scan-coverage.model';
import { SecurityScanScheduleSchema } from '@libs/security-scan/infrastructure/security-scan-schedule.model';

import { RELEASE_INDEXES } from './ensure-release-indexes';

// The schemas declare these indexes from release-index-definitions.ts, the
// list the migration builds. This pins that each one is really declared, on
// the same collection and with the very same key and options, so a schema
// that declares it some other way, or stops declaring it, is caught.
const SCHEMAS: Schema[] = [
    AgentSessionSchema,
    KodusCreditChargeModelSchema,
    IssuesSchema,
    PullRequestsSchema,
    SecurityScanSchema,
    SecurityScanCoverageSchema,
    SecurityScanScheduleSchema,
];

// The rules each index exists to enforce, written out: the schemas and the
// migration read one definition, so only a literal here catches an edit to it.
const DAY = 24 * 60 * 60;
const EXPECTED_RULES: Record<string, Record<string, unknown>> = {
    ttl_updatedAt: { expireAfterSeconds: 30 * DAY },
    idx_org_pr_spanAt: {
        partialFilterExpression: { prNumber: { $exists: true } },
    },
    organization_updated: {},
    organization_repository_fingerprint_unique: {
        unique: true,
        partialFilterExpression: { fingerprint: { $exists: true } },
    },
    idx_org_user_id_createdAt_for_seat_labels: {},
    organization_repository_recent: {},
    one_active_scan_per_repository: {
        unique: true,
        partialFilterExpression: { activeKey: { $exists: true } },
    },
    repository_file_class_unique: { unique: true },
    enabled_next_run: {},
    one_schedule_per_repository: { unique: true },
};

describe('RELEASE_INDEXES', () => {
    it('holds exactly the indexes this release added', () => {
        expect(
            RELEASE_INDEXES.map((index) => index.options.name).sort(),
        ).toEqual(Object.keys(EXPECTED_RULES).sort());
    });

    it.each(Object.entries(EXPECTED_RULES))(
        '%s enforces its rules',
        (name, rules) => {
            const { options } = RELEASE_INDEXES.find(
                (index) => index.options.name === name,
            )!;
            for (const rule of [
                'unique',
                'partialFilterExpression',
                'expireAfterSeconds',
            ]) {
                expect((options as Record<string, unknown>)[rule]).toEqual(
                    rules[rule],
                );
            }
        },
    );

    it.each(RELEASE_INDEXES.map((index) => [index.options.name, index]))(
        '%s is the index its schema declares, on its collection',
        (name, index) => {
            const declared = SCHEMAS.flatMap((schema) =>
                schema
                    .indexes()
                    .filter(([, options]) => options?.name === name)
                    .map(([key, options]) => ({
                        collection: schema.get('collection'),
                        key,
                        options,
                    })),
            );

            expect(declared).toHaveLength(1);
            const [schemaIndex] = declared;
            expect(index.collection).toBe(schemaIndex.collection);
            expect(index.key).toEqual(schemaIndex.key);
            expect(index.options).toEqual(schemaIndex.options);
        },
    );
});

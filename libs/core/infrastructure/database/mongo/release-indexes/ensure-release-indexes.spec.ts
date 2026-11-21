import { Schema } from 'mongoose';

import { AgentSessionSchema } from '@libs/agents/infrastructure/persistence/schemas/agent-session.model';
import { KodusCreditChargeModelSchema } from '@libs/analytics/infrastructure/adapters/repositories/schemas/kodusCreditCharge.model';
import { IssuesSchema } from '@libs/issues/infrastructure/adapters/repositories/schemas/issues.model';
import { PullRequestsSchema } from '@libs/platformData/infrastructure/adapters/repositories/schemas/pullRequests.model';
import { SecurityScanSchema } from '@libs/security-scan/infrastructure/security-scan.model';

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
];

describe('RELEASE_INDEXES', () => {
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

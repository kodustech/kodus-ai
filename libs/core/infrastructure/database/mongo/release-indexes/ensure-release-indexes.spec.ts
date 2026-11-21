import { Schema } from 'mongoose';

import { AgentSessionSchema } from '@libs/agents/infrastructure/persistence/schemas/agent-session.model';
import { KodusCreditChargeModelSchema } from '@libs/analytics/infrastructure/adapters/repositories/schemas/kodusCreditCharge.model';
import { IssuesSchema } from '@libs/issues/infrastructure/adapters/repositories/schemas/issues.model';
import { PullRequestsSchema } from '@libs/platformData/infrastructure/adapters/repositories/schemas/pullRequests.model';
import { SecurityScanSchema } from '@libs/security-scan/infrastructure/security-scan.model';

import { RELEASE_INDEXES } from './ensure-release-indexes';

// The migration repeats the schemas' index definitions (its build cannot
// import Mongoose models). A change on either side must reach the other, or
// the migration builds an index the code does not declare.
const SCHEMAS: Schema[] = [
    AgentSessionSchema,
    KodusCreditChargeModelSchema,
    IssuesSchema,
    PullRequestsSchema,
    SecurityScanSchema,
];

const RULES = [
    'unique',
    'partialFilterExpression',
    'expireAfterSeconds',
] as const;

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
            for (const rule of RULES) {
                expect((index.options as any)[rule]).toEqual(
                    (schemaIndex.options as any)[rule],
                );
            }
        },
    );
});

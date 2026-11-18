/**
 * Monthly spend attributes each model to the BYOK credential that paid for it.
 * The pairs must come from the `tu_cred_byok_v1` index, not from fetching
 * every BYOK span of the month (21.7M spans examined for 6.9k returned in
 * production), and must be exactly the pairs the spans recorded.
 *
 * Runs against a REAL MongoDB in a throwaway database; skipped when none is
 * reachable. Point it at one with TOKEN_USAGE_IT_MONGO_URI (or MONGODB_URI).
 */
import mongoose, { Connection, Model } from 'mongoose';

import { buildMongoUri } from '@libs/core/infrastructure/database/mongo/mongo-migration-client';
import { ensureTokenUsageIndexes } from '@libs/core/infrastructure/database/mongo/token-usage/ensure-indexes';

import {
    ObservabilityTelemetryModel,
    ObservabilityTelemetryModelSchema,
} from './schemas/observabilityTelemetry.model';
import { TokenUsageRepository } from './tokenUsage.repository';

const TEST_DB = 'kodus_token_usage_cred_it';
const ORG = 'org-cred-it';
const start = new Date('2026-11-01T00:00:00Z');
const end = new Date('2026-11-30T23:59:59Z');

const span = (tu: Record<string, unknown>, at = '2026-11-10T12:00:00Z') => ({
    name: 'llm',
    correlationId: 'c',
    duration: 1,
    timestamp: new Date(at),
    attributes: { organizationId: ORG, tu: { sys: false, ...tu } },
});

let connection: Connection | null = null;
let available = false;

describe('TokenUsageRepository.getModelCredentialPairs (real MongoDB)', () => {
    let model: Model<ObservabilityTelemetryModel>;
    let repository: TokenUsageRepository;

    beforeAll(async () => {
        const uri =
            process.env.TOKEN_USAGE_IT_MONGO_URI ??
            process.env.MONGODB_URI ??
            buildMongoUri();
        try {
            connection = await mongoose
                .createConnection(uri, {
                    dbName: TEST_DB,
                    serverSelectionTimeoutMS: 2000,
                })
                .asPromise();
            available = true;
        } catch {
            console.warn('[token-usage-cred-it] no Mongo reachable — skipping');
            return;
        }
        await connection.dropDatabase();
        model = connection.model<ObservabilityTelemetryModel>(
            ObservabilityTelemetryModel.name,
            ObservabilityTelemetryModelSchema,
        );
        await model.collection.insertMany([
            span({ isByok: true, model: 'gpt-5', credentialId: 'cred-a' }),
            span({ isByok: true, model: 'gpt-5', credentialId: 'cred-a' }),
            span({ isByok: true, model: 'claude-5', credentialId: 'cred-b' }),
            // BYOK with no credential (env key): no pair.
            span({ isByok: true, model: 'gemini-3', credentialId: '' }),
            // Not BYOK: no pair even with a credential.
            span({ isByok: false, model: 'gpt-5', credentialId: 'cred-c' }),
            // Outside the month: no pair.
            span(
                { isByok: true, model: 'gpt-4', credentialId: 'cred-d' },
                '2026-10-15T12:00:00Z',
            ),
        ] as any[]);
        await ensureTokenUsageIndexes(connection.db as any);
        repository = new TokenUsageRepository(model as any, {} as any);
    }, 30_000);

    afterAll(async () => {
        if (connection) {
            if (available) await connection.dropDatabase();
            await connection.close();
        }
    });

    const query = { organizationId: ORG, start, end, byok: true } as any;

    it('returns each (model, credential) pair the month recorded, once', async () => {
        if (!available) return;

        const pairs = await repository.getModelCredentialPairs(query);

        expect(pairs.map((p) => `${p.model}:${p.credentialId}`).sort()).toEqual(
            ['claude-5:cred-b', 'gpt-5:cred-a'],
        );
    });

    it('answers from the index without fetching a span', async () => {
        if (!available) return;

        const aggregate = jest.spyOn(model, 'aggregate');
        await repository.getModelCredentialPairs(query);
        const pipeline = aggregate.mock.calls[0][0] as any[];
        aggregate.mockRestore();

        const explained: any = await model.collection
            .aggregate(pipeline)
            .explain('executionStats');
        const stats =
            explained.executionStats ??
            explained.stages?.[0]?.$cursor?.executionStats;

        expect(stats.totalDocsExamined).toBe(0);
        expect(JSON.stringify(explained)).toContain('tu_cred_byok_v1');
    });
});

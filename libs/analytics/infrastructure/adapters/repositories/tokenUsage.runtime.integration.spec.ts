import { randomBytes } from 'crypto';

import mongoose, { type Connection } from 'mongoose';

import { deriveTu } from '@libs/core/log/token-usage-tu';

import {
    ObservabilityTelemetryModel,
    ObservabilityTelemetryModelSchema,
} from './schemas/observabilityTelemetry.model';
import { TokenUsageRepository } from './tokenUsage.repository';

// Opt-in: runs against RUNTIME_IT_MONGO_URL (locally
// mongodb://127.0.0.1:27118/?directConnection=true), in a throwaway database
// dropped after the run; skipped without it.
const base = process.env.RUNTIME_IT_MONGO_URL;
const run =
    base && process.env.SKIP_INTEGRATION !== 'true' ? describe : describe.skip;

const ORG = 'org-it';
const MONTH = new Date('2026-11-10T12:00:00Z');

/** A usage span as LLM.run writes it: dotted gen_ai keys, the caller's attrs, and the derived `tu`. */
function span(attrs: Record<string, unknown>, at = MONTH) {
    const attributes: Record<string, unknown> = {
        'organizationId': ORG,
        'gen_ai.response.model': 'claude-sonnet-4-5',
        'gen_ai.usage.output_tokens': 100,
        ...attrs,
    };
    attributes['gen_ai.usage.total_tokens'] =
        Number(attributes['gen_ai.usage.input_tokens'] ?? 0) +
        Number(attributes['gen_ai.usage.output_tokens'] ?? 0);
    attributes.tu = deriveTu(attributes);
    return {
        name: 'llm',
        correlationId: randomBytes(4).toString('hex'),
        duration: 1,
        attributes,
        timestamp: at,
    };
}

run('TokenUsageRepository.getRuntimeUsage (integration, real Mongo)', () => {
    let conn: Connection;
    let repo: TokenUsageRepository;

    beforeAll(async () => {
        const url = new URL(base!);
        url.pathname = `/runtime_usage_it_${randomBytes(4).toString('hex')}`;
        conn = await mongoose.createConnection(url.toString()).asPromise();
        const model = conn.model(
            ObservabilityTelemetryModel.name,
            ObservabilityTelemetryModelSchema,
            'observability_telemetry',
        );
        // Claude's 200K tier, as the catalog declares it.
        const pricing = {
            tieredInputThresholds: async () =>
                new Map([['claude-sonnet-4-5', [200_000]]]),
        };
        repo = new TokenUsageRepository(model as never, pricing as never);

        await conn.collection('observability_telemetry').insertMany([
            // The Run agent's model turns: one below the threshold, one above.
            span({
                'route': 'runtime',
                'runId': 'run-1',
                'task': 'runtime.plan',
                'gen_ai.run.name': 'runtime.plan.model-turn',
                'type': 'byok',
                'gen_ai.usage.input_tokens': 50_000,
            }),
            span({
                'route': 'runtime',
                'runId': 'run-1',
                'task': 'runtime.plan',
                'gen_ai.run.name': 'runtime.plan.model-turn',
                'type': 'byok',
                'gen_ai.usage.input_tokens': 250_000,
            }),
            span({
                'route': 'runtime',
                'runId': 'run-1',
                'task': 'runtime.plan',
                'gen_ai.run.name': 'runtime.plan.model-turn',
                'type': 'byok',
                'gen_ai.usage.input_tokens': 10_000,
            }),
            // The recipe author of a setup, on the managed default.
            span({
                'route': 'runtime',
                'runId': 'setup-scope-1',
                'task': 'runtime.recipe_author',
                'agentName': 'RuntimeRecipeAuthor',
                'environmentId': 'env-1',
                'repositoryId': 'repo-1',
                'gen_ai.run.name': 'runtime.recipe_author',
                'type': 'system',
                'gen_ai.usage.input_tokens': 20_000,
            }),
            // Another Run, a code review span, another org, and last month: none of them are run-1's.
            span({
                'route': 'runtime',
                'runId': 'run-2',
                'task': 'runtime.intent',
                'gen_ai.run.name': 'runtime.intent',
                'gen_ai.usage.input_tokens': 1_000,
            }),
            span({
                'route': 'codeReview',
                'prNumber': 7,
                'gen_ai.run.name': 'code-review-finder',
                'gen_ai.usage.input_tokens': 90_000,
            }),
            span({
                'route': 'runtime',
                'runId': 'run-1',
                'organizationId': 'org-other',
                'gen_ai.usage.input_tokens': 9_000,
            }),
            span(
                {
                    'route': 'runtime',
                    'runId': 'run-1',
                    'gen_ai.usage.input_tokens': 9_000,
                },
                new Date('2026-10-20T00:00:00Z'),
            ),
        ]);
    });

    afterAll(async () => {
        await conn?.dropDatabase().catch(() => undefined);
        await conn?.close();
    });

    const window = {
        organizationId: ORG,
        start: new Date('2026-11-01T00:00:00Z'),
        end: new Date('2026-12-01T00:00:00Z'),
    };

    it("sums one org's Runtime spans of the window by Run and agent, split at the model's tier threshold", async () => {
        const rows = await repo.getRuntimeUsage(window);
        const byRun = (id: string) => rows.filter((r) => r.runId === id);

        expect(rows).toHaveLength(3);
        const [turns] = byRun('run-1');
        expect(turns).toMatchObject({
            model: 'claude-sonnet-4-5',
            task: 'runtime.plan',
            runName: 'runtime.plan.model-turn',
            isByok: true,
            input: 310_000,
            output: 300,
        });
        expect(turns.byTier).toEqual([
            expect.objectContaining({ input: 60_000, output: 200 }),
            expect.objectContaining({ input: 250_000, output: 100 }),
        ]);
        expect(byRun('setup-scope-1')).toEqual([
            expect.objectContaining({
                agentName: 'RuntimeRecipeAuthor',
                environmentId: 'env-1',
                repositoryId: 'repo-1',
                isByok: false,
                input: 20_000,
            }),
        ]);
        expect(byRun('run-2')).toHaveLength(1);
    });

    it('reads only the Runs asked for', async () => {
        const rows = await repo.getRuntimeUsage({
            ...window,
            runIds: ['run-2'],
        });
        expect(rows.map((r) => r.runId)).toEqual(['run-2']);
    });
});

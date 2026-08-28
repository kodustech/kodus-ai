import { ObservabilityService } from './observability.service';

describe('ObservabilityService Mongo exporter toggle', () => {
    const originalMongoEnabled = process.env.OBSERVABILITY_MONGO_ENABLED;

    afterEach(() => {
        process.env.OBSERVABILITY_MONGO_ENABLED = originalMongoEnabled;
    });

    function buildService(): ObservabilityService {
        const configServiceMock = {
            get: jest.fn(),
        } as any;
        return new ObservabilityService(configServiceMock);
    }

    const baseDbConfig = {
        url: 'mongodb://localhost:27017/kodus',
        database: 'kodus',
    } as any;

    it('includes mongodb exporter config by default', () => {
        delete process.env.OBSERVABILITY_MONGO_ENABLED;
        const service = buildService();

        const cfg = (service as any).createObservabilityConfig(baseDbConfig, {
            serviceName: 'kodus-worker',
            enableCollections: true,
        });

        expect(cfg.mongodb).toBeDefined();
        expect(cfg.mongodb.enableObservability).toBe(true);
    });

    it('omits mongodb exporter config when OBSERVABILITY_MONGO_ENABLED=false', () => {
        process.env.OBSERVABILITY_MONGO_ENABLED = 'false';
        const service = buildService();

        const cfg = (service as any).createObservabilityConfig(baseDbConfig, {
            serviceName: 'kodus-worker',
            enableCollections: true,
        });

        expect(cfg.mongodb).toBeUndefined();
    });

    it.each([' FALSE ', 'False', '0', 'off', 'No'])(
        'treats %p as disabled (kill-switch is liberal in what counts as off)',
        (value) => {
            process.env.OBSERVABILITY_MONGO_ENABLED = value;
            const service = buildService();

            const cfg = (service as any).createObservabilityConfig(
                baseDbConfig,
                {
                    serviceName: 'kodus-worker',
                    enableCollections: true,
                },
            );

            expect(cfg.mongodb).toBeUndefined();
        },
    );

    it('keeps mongodb exporter enabled for non-off values', () => {
        process.env.OBSERVABILITY_MONGO_ENABLED = 'true';
        const service = buildService();

        const cfg = (service as any).createObservabilityConfig(baseDbConfig, {
            serviceName: 'kodus-worker',
            enableCollections: true,
        });

        expect(cfg.mongodb).toBeDefined();
    });
});

/**
 * A structured call billed by the provider but rejected by the output parse
 * (AI_NoObjectGeneratedError) used to leave the span with `error: true` and no
 * `gen_ai.usage.*` at all — the spend appeared in Langfuse and never in the
 * Mongo cost dataset.
 */
describe('ObservabilityService.runAiSdkLLMInSpan', () => {
    function buildService() {
        const service = new ObservabilityService({ get: jest.fn() } as any);
        const span = { setAttributes: jest.fn() };
        (service as any).getObsInstance = () => ({
            startSpan: () => span,
            withSpan: (_span: any, fn: () => any) => fn(),
            getContext: () => ({ correlationId: 'corr_test' }),
        });
        // Attributes the span carries from the start (org/team/type) are applied
        // by runInSpan; only the usage projection is under test here.
        const usageAttrs = () =>
            span.setAttributes.mock.calls
                .map(([attrs]) => attrs)
                .filter((attrs) => 'gen_ai.usage.total_tokens' in attrs);
        return { service, span, usageAttrs };
    }

    const usage = {
        inputTokens: 766,
        outputTokens: 2503,
        totalTokens: 3269,
    };

    it('records usage on success', async () => {
        const { service, usageAttrs } = buildService();

        await service.runAiSdkLLMInSpan({
            spanName: 'code-review-generalist-recovery',
            model: 'accounts/fireworks/models/deepseek-v4-flash-0731',
            attrs: { organizationId: 'org-1', type: 'system' },
            exec: async () => ({ usage }),
        });

        expect(usageAttrs()).toHaveLength(1);
        expect(usageAttrs()[0]['gen_ai.usage.total_tokens']).toBe(3269);
        // The success span must stay exactly what it was before the error path
        // existed — `finishReason` is stamped only from a failed call.
        expect(usageAttrs()[0]).not.toHaveProperty('finishReason');
    });

    it('records the billed usage when the call throws after the provider answered', async () => {
        const { service, usageAttrs } = buildService();
        const err = Object.assign(
            new Error('No object generated: response did not match schema.'),
            { name: 'AI_NoObjectGeneratedError', finishReason: 'stop', usage },
        );

        await expect(
            service.runAiSdkLLMInSpan({
                spanName: 'code-review-generalist-recovery',
                model: 'accounts/fireworks/models/deepseek-v4-flash-0731',
                attrs: { organizationId: 'org-1', type: 'system' },
                exec: async () => {
                    throw err;
                },
            }),
        ).rejects.toBe(err);

        const [attrs] = usageAttrs();
        expect(attrs['gen_ai.usage.total_tokens']).toBe(3269);
        expect(attrs.finishReason).toBe('stop');
        // tu is what the billing aggregation reads — an error span still has to
        // carry it, else the tokens stay invisible to the cost pipeline.
        expect(attrs.tu).toMatchObject({ total: 3269 });
    });

    it('writes no cost span when the call failed before any generation', async () => {
        const { service, usageAttrs } = buildService();

        await expect(
            service.runAiSdkLLMInSpan({
                spanName: 'code-review-generalist',
                exec: async () => {
                    throw new Error('fetch failed');
                },
            }),
        ).rejects.toThrow('fetch failed');

        expect(usageAttrs()).toHaveLength(0);
    });
});

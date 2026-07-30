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

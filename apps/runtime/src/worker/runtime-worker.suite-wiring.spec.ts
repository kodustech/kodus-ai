import { loadWorkerConfig } from '../shared/config';
import { DEV_SECRET_SEAL_KEY_HEX } from '../testing/dev-seal-key';
import { RuntimeWorkerModule } from './runtime-worker.module';
import { SUITE_RUNS, SUITE_SERVICE, SuiteService } from './suite/suite-service';
import { PgSuiteRuns } from './suite/pg-suite-runs';
import { RUN_DEPS_FACTORY } from './dbos/run-deps.factory';
import { SuiteRunStage } from './suite/suite-stage';
import { RuntimeMetrics } from '@libs/runtime/telemetry';

// The production wiring of the suite (docs/runtime/e2e-suites.md section 11): the service the workflow runs, the run store the
// retry reads, and the queue the engine registers. No database is opened by building the providers.
const config = loadWorkerConfig({ RUNTIME_SECRET_SEAL_KEY: DEV_SECRET_SEAL_KEY_HEX, RUNTIME_SUITE_MAX_HOSTS: '5' });
const providers = RuntimeWorkerModule.forConfig(config).providers as any[];
const provider = (token: unknown) => providers.find((p) => p?.provide === token);

describe('the suite in the worker module', () => {
    it('gives the Run the same suite service as a stage, so Run mode and CI mode run one engine', async () => {
        const provider = providers.find((p) => p?.provide === RUN_DEPS_FACTORY);
        const pool = { query: jest.fn() } as any;
        const factory = await provider.useFactory(pool, {} as any, { publish: jest.fn() }, new RuntimeMetrics(), null, {} as any, { open: jest.fn() }, { get: jest.fn() });
        const req = { runId: 'r1', correlationId: 'c', organizationId: 'o', repository: { id: 'repo', name: 'shop' }, pullRequest: { number: 1, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) }, environment: { imageId: 'img', expose: [] } } as any;
        expect(factory.forRun(req).suite).toBeInstanceOf(SuiteRunStage);
    });

    it('provides the run store of the suites and the service the workflow runs', () => {
        const pool = { query: jest.fn() } as any;
        expect(provider(SUITE_RUNS).useFactory(pool)).toBeInstanceOf(PgSuiteRuns);
        const service = provider(SUITE_SERVICE).useFactory(pool, { envForSuite: jest.fn() }, { get: jest.fn() }, provider(SUITE_RUNS).useFactory(pool), { publish: jest.fn() });
        expect(service).toBeInstanceOf(SuiteService);
        expect((service as any).d.publisher).toBeDefined();
    });
});
